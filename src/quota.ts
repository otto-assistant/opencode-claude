/**
 * Subscription quota, straight from Anthropic.
 *
 * Every Messages API response carries `anthropic-ratelimit-unified-*` headers
 * describing BOTH limit windows at once:
 *
 *   anthropic-ratelimit-unified-5h-utilization: 0.56
 *   anthropic-ratelimit-unified-5h-reset: 1786797000
 *   anthropic-ratelimit-unified-7d-utilization: 0.93
 *   anthropic-ratelimit-unified-7d-status: allowed_warning
 *   anthropic-ratelimit-unified-representative-claim: seven_day
 *
 * This is strictly better than the Agent SDK's `rate_limit_event`, which
 * reports one window at a time — a five-hour window at 56% looks healthy while
 * the weekly window that actually gates you sits at 93%.
 *
 * Two ways in, and the cheap one is the default:
 * 1. Free: harvest the headers from requests the plugin already makes (the
 *    title/summary meta path). Costs nothing extra.
 * 2. On demand: a minimal Messages call (~20 input tokens) when the operator
 *    asks the panel to refresh. Never automatic — polling a quota endpoint by
 *    spending quota is a bad trade.
 *
 * Store: $XDG_DATA_HOME/opencode-claude/quota.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { accountConfigDir, type ClaudeAccount } from "./accounts.js";
import { readClaudeCliOAuthCredentials } from "./credentials.js";
import { log } from "./log.js";

export type QuotaWindow = {
  /** 0..1 of the window consumed, as Anthropic reports it. */
  utilization: number;
  /** 1 - utilization, clamped — what the operator actually wants to read. */
  remaining: number;
  status?: string;
  /** Epoch ms when this window refills. */
  resetsAt?: number;
  /** Warning threshold Anthropic says was crossed, when it says so. */
  surpassedThreshold?: number;
};

export type AccountQuota = {
  windows: Partial<Record<"fiveHour" | "sevenDay" | "opus", QuotaWindow>>;
  /** Which window is currently the binding constraint. */
  representative?: "five_hour" | "seven_day" | string;
  status?: string;
  resetsAt?: number;
  overage?: { status?: string; disabledReason?: string };
  fallback?: { availability?: string; percentage?: number };
  /**
   * Anthropic org this token belongs to. Two accounts sharing it are two keys
   * to ONE subscription: separate grants, but a single quota pool. Worth
   * surfacing — the whole point of a second account is a second pool.
   */
  organizationId?: string;
  fetchedAt: number;
  /**
   * "headers" (free harvest), "probe" (explicit refresh) or "plan-usage" (the
   * Agent SDK control channel, read at the end of a turn).
   */
  source: "headers" | "probe" | "plan-usage";
};

type QuotaStore = { version: 1; accounts: Record<string, AccountQuota> };

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const PREFIX = "anthropic-ratelimit-unified-";

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

function num(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Anthropic sends epoch SECONDS; everything else in this plugin is ms. */
function resetMs(value: string | null): number | undefined {
  const seconds = num(value);
  if (seconds === undefined) return undefined;
  return seconds > 1e12 ? seconds : seconds * 1000;
}

function windowFrom(
  headers: Headers,
  key: string,
): QuotaWindow | undefined {
  const utilization = num(headers.get(`${PREFIX}${key}-utilization`));
  const status = headers.get(`${PREFIX}${key}-status`) ?? undefined;
  const resetsAt = resetMs(headers.get(`${PREFIX}${key}-reset`));
  if (utilization === undefined && !status && resetsAt === undefined) {
    return undefined;
  }
  const used = utilization ?? 0;
  return {
    utilization: used,
    remaining: Math.max(0, Math.min(1, 1 - used)),
    ...(status ? { status } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(num(headers.get(`${PREFIX}${key}-surpassed-threshold`)) !== undefined
      ? { surpassedThreshold: num(headers.get(`${PREFIX}${key}-surpassed-threshold`))! }
      : {}),
  };
}

/**
 * Parse the unified headers. Returns null when the response carried none —
 * a non-subscription token, or an endpoint that does not report them
 * (`count_tokens` is free but silent, which is why it cannot be the probe).
 */
export function parseQuotaHeaders(
  headers: Headers,
  source: AccountQuota["source"] = "headers",
  now: number = Date.now(),
): AccountQuota | null {
  const fiveHour = windowFrom(headers, "5h");
  const sevenDay = windowFrom(headers, "7d");
  const opus = windowFrom(headers, "opus");
  const status = headers.get(`${PREFIX}status`) ?? undefined;
  if (!fiveHour && !sevenDay && !opus && !status) return null;

  const overageStatus = headers.get(`${PREFIX}overage-status`) ?? undefined;
  const overageReason =
    headers.get(`${PREFIX}overage-disabled-reason`) ?? undefined;
  const fallback = headers.get(`${PREFIX}fallback`) ?? undefined;
  const fallbackPct = num(headers.get(`${PREFIX}fallback-percentage`));

  return {
    windows: {
      ...(fiveHour ? { fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : {}),
      ...(opus ? { opus } : {}),
    },
    ...(headers.get(`${PREFIX}representative-claim`)
      ? { representative: headers.get(`${PREFIX}representative-claim`)! }
      : {}),
    ...(status ? { status } : {}),
    ...(resetMs(headers.get(`${PREFIX}reset`)) !== undefined
      ? { resetsAt: resetMs(headers.get(`${PREFIX}reset`))! }
      : {}),
    ...(overageStatus || overageReason
      ? {
          overage: {
            ...(overageStatus ? { status: overageStatus } : {}),
            ...(overageReason ? { disabledReason: overageReason } : {}),
          },
        }
      : {}),
    ...(fallback || fallbackPct !== undefined
      ? {
          fallback: {
            ...(fallback ? { availability: fallback } : {}),
            ...(fallbackPct !== undefined ? { percentage: fallbackPct } : {}),
          },
        }
      : {}),
    ...(headers.get("anthropic-organization-id")
      ? { organizationId: headers.get("anthropic-organization-id")! }
      : {}),
    fetchedAt: now,
    source,
  };
}

/**
 * Account ids that share an Anthropic organization with the given one — i.e.
 * the same subscription signed in twice. Empty when nothing is known yet.
 */
export function accountsSharingSubscription(
  accountId: string,
): string[] {
  const all = readStore().accounts;
  const org = all[normalizeKey(accountId)]?.organizationId;
  if (!org) return [];
  return Object.entries(all)
    .filter(([id, q]) => id !== normalizeKey(accountId) && q.organizationId === org)
    .map(([id]) => id);
}

/**
 * Harvest quota from a response the plugin made for another reason. Free —
 * call it wherever an Anthropic response passes through.
 */
export function recordQuotaFromHeaders(
  accountId: string | undefined,
  headers: Headers,
  source: AccountQuota["source"] = "headers",
): AccountQuota | null {
  const parsed = parseQuotaHeaders(headers, source);
  if (!parsed) return null;
  const store = readStore();
  store.accounts[normalizeKey(accountId)] = parsed;
  writeStore(store);
  return parsed;
}

/**
 * Plan usage as the Agent SDK control channel reports it (`get_usage`).
 *
 * This is the only path that sees BOTH windows on the Agent SDK route. Turns
 * run inside the `claude` subprocess, so the `anthropic-ratelimit-unified-*`
 * response headers never reach this process; all that surfaces mid-stream is
 * `rate_limit_event`, one window at a time and only when the SDK feels like
 * emitting it. Hence the stored numbers going hours stale while turns ran.
 *
 * Two unit conversions, and both bite silently if skipped:
 *   - `utilization` here is 0-100. The header path is 0..1. Feeding one
 *     through the other's arithmetic yields remaining = -94.
 *   - `resets_at` here is an ISO 8601 string. The store keeps epoch ms.
 *
 * Replaces rather than merges: unlike `rate_limit_event`, this payload
 * describes every window at once, so a stale sibling would be a lie.
 */
export function recordQuotaFromPlanUsage(
  accountId: string | undefined,
  usage: unknown,
  now: number = Date.now(),
): AccountQuota | null {
  const parsed = parsePlanUsage(usage, now);
  if (!parsed) return null;
  const store = readStore();
  const key = normalizeKey(accountId);
  const previous = store.accounts[key];
  store.accounts[key] = {
    ...parsed,
    // Facts this payload does not carry are worth keeping.
    ...(previous?.organizationId ? { organizationId: previous.organizationId } : {}),
    ...(previous?.overage ? { overage: previous.overage } : {}),
  };
  writeStore(store);
  return store.accounts[key];
}

/** Percentage (0-100) consumed -> the 0..1 `remaining` the store speaks. */
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
 * Merge one window from an Agent SDK `rate_limit_event` into the stored quota.
 *
 * The SDK reports a single window per event, so this must NOT replace the
 * record — overwriting would erase the other window and hide exactly the case
 * that matters (five-hour healthy, weekly nearly spent). Without this, quota
 * only refreshed on meta requests or a manual probe, and a host whose small
 * model is not `claude-code` never refreshed at all while running turns.
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
    ...(previous ?? { windows: {}, fetchedAt: now, source: "headers" }),
    windows: {
      ...(previous?.windows ?? {}),
      [key]: {
        utilization,
        remaining: Math.max(0, Math.min(1, 1 - utilization)),
        ...(status ? { status } : {}),
        ...(resetsAtRaw !== undefined ? { resetsAt: resetsAtRaw } : {}),
      },
    },
    // The event names the window it is about, which is the window currently
    // being reported on — treat it as the binding claim.
    representative: type,
    ...(status ? { status } : {}),
    ...(previous?.organizationId ? { organizationId: previous.organizationId } : {}),
    fetchedAt: now,
    source: "headers",
  };
  store.accounts[id] = merged;
  writeStore(store);
  return merged;
}

/**
 * One-line "what is left" for display inside a session, e.g.
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

/** Forget an account's quota — a disconnected login's numbers are not its own. */
/** Move an account's quota to a new id (see renameAccount). */
export function renameAccountQuota(oldId: string, newId: string): void {
  const store = readStore();
  const entry = store.accounts[normalizeKey(oldId)];
  if (!entry) return;
  delete store.accounts[normalizeKey(oldId)];
  store.accounts[normalizeKey(newId)] = entry;
  writeStore(store);
}

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

/**
 * Explicit refresh: the smallest possible real Messages call. `count_tokens`
 * would be free but returns no quota headers, so a 1-token completion is the
 * cheapest way to ask. Costs ~20 input tokens against the very window it
 * measures, which is why nothing calls this on a timer.
 */
export async function probeAccountQuota(
  account: ClaudeAccount,
  options?: { signal?: AbortSignal },
): Promise<AccountQuota> {
  const creds = readClaudeCliOAuthCredentials(
    account.configDir ? { configDir: account.configDir } : undefined,
  );
  if (!creds?.accessToken) {
    throw new Error(
      `account "${account.id}" is not connected — no credentials in ${accountConfigDir(account)}`,
    );
  }

  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${creds.accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-dangerous-direct-browser-access": "true",
      "user-agent": "claude-cli/2.0.0 (external, cli)",
      "x-app": "cli",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      // OAuth inference is rejected without the CLI preamble as the first
      // system block — same rule the meta path documents.
      system: [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI." },
      ],
      messages: [{ role: "user", content: "hi" }],
    }),
    signal: options?.signal ?? AbortSignal.timeout(20_000),
  });

  // A 429 still carries the headers, and they are exactly what we want then.
  const parsed = recordQuotaFromHeaders(account.id, response.headers, "probe");
  if (!parsed) {
    const text = await response.text().catch(() => "");
    throw new Error(
      response.ok
        ? "Anthropic returned no rate-limit headers for this token"
        : `quota probe failed (HTTP ${response.status}): ${text.slice(0, 200)}`,
    );
  }
  log.info("[opencode-claude] quota probed", {
    account: account.id,
    fiveHour: parsed.windows.fiveHour?.utilization,
    sevenDay: parsed.windows.sevenDay?.utilization,
  });
  return parsed;
}

/** Test helper. */
export function __resetQuotaStore(): void {
  writeStore({ version: 1, accounts: {} });
}
