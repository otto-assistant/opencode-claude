/**
 * Per-account usage counters.
 *
 * The rate-limit tracker answers "am I blocked and until when". This answers
 * "how much has each subscription actually been used" — turns and tokens,
 * totals plus a daily roll-up — which is what makes a multi-account setup
 * readable at a glance.
 *
 * Store: $XDG_DATA_HOME/opencode-claude/usage.json
 * Env: OPENCODE_CLAUDE_USAGE_STORE overrides the path (tests).
 *
 * Cost is deliberately absent: these are subscription turns, not metered API
 * calls, so a dollar figure would be fiction.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type UsageCounters = {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type AccountUsage = UsageCounters & {
  lastUsedAt?: number;
  /** ISO date (UTC) → counters, newest kept, older pruned. */
  days: Record<string, UsageCounters>;
};

type UsageStore = {
  version: 1;
  accounts: Record<string, AccountUsage>;
};

/** Keep a month of history — enough to see a trend, small enough to stay fast. */
const RETAINED_DAYS = 30;

const DEFAULT_ACCOUNT_KEY = "default";

function normalizeKey(accountId?: string): string {
  const key = accountId?.trim().toLowerCase();
  return key || DEFAULT_ACCOUNT_KEY;
}

function storePath(): string {
  const override = process.env.OPENCODE_CLAUDE_USAGE_STORE;
  if (override && override.trim()) return override.trim();
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "usage.json");
}

function emptyCounters(): UsageCounters {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function readStore(): UsageStore {
  const path = storePath();
  if (!existsSync(path)) return { version: 1, accounts: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return { version: 1, accounts: {} };
    const accounts = (parsed as { accounts?: unknown }).accounts;
    return {
      version: 1,
      accounts:
        accounts && typeof accounts === "object"
          ? (accounts as Record<string, AccountUsage>)
          : {},
    };
  } catch {
    return { version: 1, accounts: {} };
  }
}

function writeStore(store: UsageStore): void {
  try {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
  } catch {
    // usage accounting must never break a turn
  }
}

function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function add(target: UsageCounters, delta: UsageCounters): UsageCounters {
  return {
    turns: target.turns + delta.turns,
    inputTokens: target.inputTokens + delta.inputTokens,
    outputTokens: target.outputTokens + delta.outputTokens,
    cacheReadTokens: target.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens + delta.cacheWriteTokens,
  };
}

function prune(days: Record<string, UsageCounters>): Record<string, UsageCounters> {
  const keys = Object.keys(days).sort();
  if (keys.length <= RETAINED_DAYS) return days;
  const keep = new Set(keys.slice(-RETAINED_DAYS));
  return Object.fromEntries(Object.entries(days).filter(([k]) => keep.has(k)));
}

/**
 * Record one completed turn. `usage` is the OpenAI-shaped object the proxy
 * already computes; a turn that produced no usage still counts as a turn.
 */
export function recordTurnUsage(
  accountId: string | undefined,
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
  } | null,
  now: number = Date.now(),
): void {
  const key = normalizeKey(accountId);
  const delta: UsageCounters = {
    turns: 1,
    inputTokens: Math.max(0, usage?.prompt_tokens ?? 0),
    outputTokens: Math.max(0, usage?.completion_tokens ?? 0),
    cacheReadTokens: Math.max(0, usage?.prompt_tokens_details?.cached_tokens ?? 0),
    cacheWriteTokens: Math.max(
      0,
      usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
    ),
  };
  const store = readStore();
  const current: AccountUsage = store.accounts[key] ?? {
    ...emptyCounters(),
    days: {},
  };
  const day = dayKey(now);
  const days = { ...current.days };
  days[day] = add(days[day] ?? emptyCounters(), delta);
  store.accounts[key] = {
    ...add(current, delta),
    lastUsedAt: now,
    days: prune(days),
  };
  writeStore(store);
}

/** Move an account's counters to a new id (see renameAccount). */
export function renameAccountUsage(oldId: string, newId: string): void {
  const store = readStore();
  const entry = store.accounts[normalizeKey(oldId)];
  if (!entry) return;
  delete store.accounts[normalizeKey(oldId)];
  store.accounts[normalizeKey(newId)] = entry;
  writeStore(store);
}

export type AccountUsageSummary = UsageCounters & {
  lastUsedAt?: number;
  today: UsageCounters;
  last7Days: UsageCounters;
  /** Oldest-first daily series for sparklines. */
  series: Array<{ date: string; turns: number; totalTokens: number }>;
};

function sumDays(
  days: Record<string, UsageCounters>,
  fromDay: string,
): UsageCounters {
  return Object.entries(days)
    .filter(([date]) => date >= fromDay)
    .reduce((acc, [, counters]) => add(acc, counters), emptyCounters());
}

export function getAccountUsage(
  accountId: string | undefined,
  now: number = Date.now(),
): AccountUsageSummary {
  const stored = readStore().accounts[normalizeKey(accountId)];
  const base: AccountUsage = stored ?? { ...emptyCounters(), days: {} };
  const today = dayKey(now);
  const weekStart = dayKey(now - 6 * 24 * 60 * 60 * 1000);
  return {
    turns: base.turns,
    inputTokens: base.inputTokens,
    outputTokens: base.outputTokens,
    cacheReadTokens: base.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens,
    ...(base.lastUsedAt ? { lastUsedAt: base.lastUsedAt } : {}),
    today: base.days[today] ?? emptyCounters(),
    last7Days: sumDays(base.days, weekStart),
    series: Object.entries(base.days)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, counters]) => ({
        date,
        turns: counters.turns,
        totalTokens: counters.inputTokens + counters.outputTokens,
      })),
  };
}

export function getAllAccountUsage(
  now: number = Date.now(),
): Record<string, AccountUsageSummary> {
  const store = readStore();
  return Object.fromEntries(
    Object.keys(store.accounts).map((id) => [id, getAccountUsage(id, now)]),
  );
}

/** Test helper: wipe the store. */
export function __resetUsageStore(): void {
  writeStore({ version: 1, accounts: {} });
}
