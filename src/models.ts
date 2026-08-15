/**
 * Claude Code model catalog (from OpenChamber harness registry).
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
import { getAccountQuota } from "./quota.js";

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
 * appears once per account, and each NAME carries the account label — that
 * label is what OpenChamber prints in the model picker and in the session
 * header, so the account a session runs on is readable at a glance.
 */
/**
 * Remaining quota as a model-name suffix, e.g. `5h 96% · 7d 4%`.
 *
 * The model name is the one string this plugin controls that the host renders
 * next to the composer, so it is where "how much is left on the account I am
 * about to use" can actually be read at the moment of choosing. Refreshes
 * whenever the host rebuilds the catalog.
 */
export function quotaNameSuffix(accountId: string): string {
  if (nameQuotaDisabled()) return "";
  const quota = getAccountQuota(accountId);
  if (!quota) return "";
  const parts: string[] = [];
  const five = quota.windows.fiveHour;
  const seven = quota.windows.sevenDay;
  if (five) parts.push(`5h ${Math.round(five.remaining * 100)}%`);
  if (seven) parts.push(`7d ${Math.round(seven.remaining * 100)}%`);
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
  return getAccounts().flatMap((account) => {
    const suffix = quotaNameSuffix(account.id);
    return CLAUDE_CODE_MODELS.map((model) => ({
      ...model,
      id: composeAccountModelId(model.id, account),
      name: `${model.name} · ${account.label}${suffix}`,
      // resolvedId stays the real Claude model — the account rides the id.
      ...(model.resolvedId ? { resolvedId: model.resolvedId } : {}),
    }));
  });
}

/** Catalog for one account, with bare ids (used to build per-account menus). */
export function getClaudeModelsForAccount(account: ClaudeAccount): ClaudeModel[] {
  return CLAUDE_CODE_MODELS.map((model) => ({
    ...model,
    id: composeAccountModelId(model.id, account),
    name: isMultiAccount() ? `${model.name} · ${account.label}` : model.name,
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
