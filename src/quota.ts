/**
 * Subscription quota, without touching credentials.
 *
 * Post-#12 the plugin never talks to Anthropic directly — every request runs
 * inside the `claude` CLI spawned by the Agent SDK. The
 * `anthropic-ratelimit-unified-*` response headers therefore never reach this
 * process. Two CLI-owned signals replace them:
 *
 * 1. The SDK control channel's `get_usage` — the structured data behind the
 *    CLI's `/usage` command. It reports EVERY window at once (five-hour,
 *    seven-day, per-model), which is strictly better than the SDK's
 *    `rate_limit_event` (one window at a time, only when it feels like it):
 *    a five-hour window at 56% looks healthy while the weekly window that
 *    actually gates you sits at 93%. It reads the claude.ai usage endpoint —
 *    no Messages API call, no quota spent.
 * 2. `rate_limit_event`s harvested from turns that are already running —
 *    merged one window at a time, never replacing the other window.
 *
 * Store: $XDG_DATA_HOME/opencode-claude/quota.json
 * Env: OPENCODE_CLAUDE_QUOTA_STORE overrides the path (tests).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type QuotaWindow = {
  /** 0..1 of the window consumed. */
  utilization: number;
  /** 1 - utilization, clamped — what the operator actually wants to read. */
  remaining: number;
  status?: string;
  /** Epoch ms when this window refills. */
  resetsAt?: number;
};

export type AccountQuota = {
  windows: Partial<Record<"fiveHour" | "sevenDay" | "opus", QuotaWindow>>;
  /** Which window is currently the binding constraint, when known. */
  representative?: string;
  status?: string;
  fetchedAt: number;
  /** "plan-usage" (control channel) or "event" (merged rate_limit_event). */
  source: "plan-usage" | "event";
};

type QuotaStore = { version: 1; accounts: Record<string, AccountQuota> };

function normalizeKey(accountId?: string): string {
  const key = accountId?.trim().toLowerCase();
  return key || "default";
}

function storePath(): string {
  const override = process.env.OPENCODE_CLAUDE_QUOTA_STORE;
  if (override && override.trim()) return override.trim();
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "quota.json");
}

function readStore(): QuotaStore {
  const path = storePath();
  if (!existsSync(path)) return { version: 1, accounts: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const accounts = (parsed as { accounts?: unknown })?.accounts;
    return {
      version: 1,
      accounts:
        accounts && typeof accounts === "object"
          ? (accounts as Record<string, AccountQuota>)
          : {},
    };
  } catch {
    return { version: 1, accounts: {} };
  }
}

function writeStore(store: QuotaStore): void {
  try {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
  } catch {
    // quota reporting must never break a turn
  }
}

/** Percentage (0-100) consumed → the 0..1 window the store speaks. */
function planWindow(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as { utilization?: unknown; resets_at?: unknown };
  if (typeof entry.utilization !== "number" || !Number.isFinite(entry.utilization)) {
    return undefined;
  }
  const utilization = Math.min(1, Math.max(0, entry.utilization / 100));
  const window: QuotaWindow = {
    utilization,
    remaining: Math.min(1, Math.max(0, 1 - utilization)),
  };
  if (typeof entry.resets_at === "string") {
    const at = Date.parse(entry.resets_at);
    if (Number.isFinite(at)) window.resetsAt = at;
  }
  return window;
}

/**
 * Parse the SDK control channel `get_usage` payload.
 *
 * Two unit conversions, and both bite silently if skipped:
 * - `utilization` here is 0-100; the store keeps 0..1. Feeding one through
 *   the other's arithmetic yields remaining = -94.
 * - `resets_at` here is an ISO 8601 string; the store keeps epoch ms.
 */
export function parsePlanUsage(
  usage: unknown,
  now: number = Date.now(),
): AccountQuota | null {
  if (!usage || typeof usage !== "object") return null;
  const payload = usage as {
    rate_limits_available?: unknown;
    rate_limits?: unknown;
  };
  if (payload.rate_limits_available === false) return null;
  const limits = payload.rate_limits;
  if (!limits || typeof limits !== "object") return null;
  const source = limits as Record<string, unknown>;
  const fiveHour = planWindow(source.five_hour);
  const sevenDay = planWindow(source.seven_day);
  const opus = planWindow(source.seven_day_opus);
  if (!fiveHour && !sevenDay && !opus) return null;
  return {
    windows: {
      ...(fiveHour ? { fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : {}),
      ...(opus ? { opus } : {}),
    },
    fetchedAt: now,
    source: "plan-usage",
  };
}

/**
 * Record a control-channel payload. Replaces rather than merges: unlike
 * `rate_limit_event`, this payload describes every window at once, so a
 * stale sibling would be a lie.
 */
export function recordQuotaFromPlanUsage(
  accountId: string | undefined,
  usage: unknown,
  now: number = Date.now(),
): AccountQuota | null {
  const parsed = parsePlanUsage(usage, now);
  if (!parsed) return null;
  const store = readStore();
  store.accounts[normalizeKey(accountId)] = parsed;
  writeStore(store);
  return parsed;
}

/**
 * Merge one window from an Agent SDK `rate_limit_event` into the stored
 * quota. The SDK reports a single window per event, so this must NOT replace
 * the record — overwriting would erase the other window and hide exactly the
 * case that matters (five-hour healthy, weekly nearly spent).
 */
export function mergeSdkRateLimitEvent(
  accountId: string | undefined,
  info: unknown,
  now: number = Date.now(),
): AccountQuota | null {
  if (!info || typeof info !== "object") return null;
  const raw = info as Record<string, unknown>;
  const utilization =
    typeof raw.utilization === "number" && Number.isFinite(raw.utilization)
      ? raw.utilization
      : undefined;
  const type = typeof raw.rateLimitType === "string" ? raw.rateLimitType : "";
  const key =
    type === "five_hour" ? "fiveHour" : type === "seven_day" ? "sevenDay" : null;
  if (!key || utilization === undefined) return null;

  const resetsAtRaw =
    typeof raw.resetsAt === "number" && Number.isFinite(raw.resetsAt)
      ? raw.resetsAt > 1e12
        ? raw.resetsAt
        : raw.resetsAt * 1000
      : undefined;
  const status = typeof raw.status === "string" ? raw.status : undefined;

  const store = readStore();
  const id = normalizeKey(accountId);
  const previous = store.accounts[id];
  const merged: AccountQuota = {
    ...(previous ?? { windows: {}, fetchedAt: now, source: "event" as const }),
    windows: {
      ...(previous?.windows ?? {}),
      [key]: {
        utilization,
        remaining: Math.max(0, Math.min(1, 1 - utilization)),
        ...(status ? { status } : {}),
        ...(resetsAtRaw !== undefined ? { resetsAt: resetsAtRaw } : {}),
      },
    },
    // The event names the window it reports on — the currently binding claim.
    representative: type,
    ...(status ? { status } : {}),
    fetchedAt: now,
    source: "event",
  };
  store.accounts[id] = merged;
  writeStore(store);
  return merged;
}

/**
 * One-line "what is left" for display, e.g.
 * `5h 43% left · 7d 7% left (binding, resets in 2d 18h)`.
 * Returns null when nothing is known yet.
 */
export function formatQuotaSummary(
  quota: AccountQuota | null,
  now: number = Date.now(),
): string | null {
  if (!quota) return null;
  const parts: string[] = [];
  const render = (
    win: QuotaWindow | undefined,
    label: string,
    binding: boolean,
  ) => {
    if (!win) return;
    const left = Math.round(win.remaining * 100);
    const detail: string[] = [];
    if (binding) detail.push("binding");
    if (win.resetsAt && win.resetsAt > now) {
      detail.push(`resets in ${formatShortDuration(win.resetsAt - now)}`);
    }
    parts.push(
      `${label} ${left}% left${detail.length ? ` (${detail.join(", ")})` : ""}`,
    );
  };
  render(quota.windows.fiveHour, "5h", quota.representative === "five_hour");
  render(quota.windows.sevenDay, "7d", quota.representative === "seven_day");
  render(quota.windows.opus, "opus", quota.representative === "opus");
  return parts.length ? parts.join(" · ") : null;
}

/** Compact duration for in-session notes: days once past two of them. */
export function formatShortDuration(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours ? `${days}d ${remHours}h` : `${days}d`;
  }
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

/** Move an account's quota to a new id (see renameAccount). */
export function renameAccountQuota(oldId: string, newId: string): void {
  const store = readStore();
  const entry = store.accounts[normalizeKey(oldId)];
  if (!entry) return;
  delete store.accounts[normalizeKey(oldId)];
  store.accounts[normalizeKey(newId)] = entry;
  writeStore(store);
}

/** Forget an account's quota — a removed account's numbers are not its own. */
export function clearAccountQuota(accountId: string): void {
  const store = readStore();
  delete store.accounts[normalizeKey(accountId)];
  writeStore(store);
}

export function getAccountQuota(accountId?: string): AccountQuota | null {
  return readStore().accounts[normalizeKey(accountId)] ?? null;
}

export function getAllAccountQuota(): Record<string, AccountQuota> {
  return readStore().accounts;
}

/** Test helper. */
export function __resetQuotaStore(): void {
  writeStore({ version: 1, accounts: {} });
}
