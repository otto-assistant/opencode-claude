/**
 * Who each account actually is.
 *
 * `GET /api/oauth/profile` with a Claude Code OAuth token returns the account
 * (email, uuid) and its organization (name, uuid, type, rate-limit tier).
 *
 * This exists because "connected" is not the same as "a different
 * subscription". A browser already signed in to claude.ai approves the consent
 * screen with the CURRENT session and never offers an account picker, so
 * connecting a second account can silently re-authorize the first one:
 * different OAuth grants, different refresh chains, everything looks like two
 * accounts — and it is one login with one quota pool. Showing the email makes
 * that obvious instead of leaving it to be inferred from a matching org uuid.
 *
 * Store: $XDG_DATA_HOME/opencode-claude/identity.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { accountConfigDir, labelEmail, type ClaudeAccount } from "./accounts.js";
import { readClaudeCliOAuthCredentials } from "./credentials.js";
import { log } from "./log.js";

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
/** Caller's role in its org/workspace. Not a member list — see the note below. */
const ROLES_URL = "https://api.anthropic.com/api/oauth/claude_cli/roles";

export type AccountIdentity = {
  email?: string;
  displayName?: string;
  /** Stable id of the Claude login — the definitive duplicate check. */
  accountUuid?: string;
  organizationName?: string;
  organizationUuid?: string;
  /** e.g. "claude_team", "claude_max". */
  organizationType?: string;
  rateLimitTier?: string;
  /** "active", "canceled"… straight from the profile. */
  subscriptionStatus?: string;
  /** Plan on the account itself, independent of the org. */
  plan?: "max" | "pro" | "free";
  /**
   * This account's role in its organization ("admin", "member"…) and workspace.
   *
   * Deliberately NOT a member list: listing an organization's members needs a
   * claude.ai account session, and every /api/organizations/<uuid>/members call
   * with a Claude Code OAuth token is refused with account_session_invalid. The
   * plugin can only describe the tokens it holds.
   */
  organizationRole?: string;
  workspaceName?: string;
  workspaceRole?: string;
  fetchedAt: number;
};

type IdentityStore = { version: 1; accounts: Record<string, AccountIdentity> };

function normalizeKey(accountId?: string): string {
  const key = accountId?.trim().toLowerCase();
  return key || "default";
}

function storePath(): string {
  const override = process.env.OPENCODE_CLAUDE_IDENTITY_STORE;
  if (override && override.trim()) return override.trim();
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "identity.json");
}

function readStore(): IdentityStore {
  const path = storePath();
  if (!existsSync(path)) return { version: 1, accounts: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const accounts = (parsed as { accounts?: unknown })?.accounts;
    return {
      version: 1,
      accounts:
        accounts && typeof accounts === "object"
          ? (accounts as Record<string, AccountIdentity>)
          : {},
    };
  } catch {
    return { version: 1, accounts: {} };
  }
}

function writeStore(store: IdentityStore): void {
  try {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
  } catch {
    // identity is informational — never break a turn over it
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseProfile(
  payload: unknown,
  now: number = Date.now(),
): AccountIdentity | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const account = (root.account ?? {}) as Record<string, unknown>;
  const org = (root.organization ?? {}) as Record<string, unknown>;
  const identity: AccountIdentity = {
    ...(str(account.email) ? { email: str(account.email)! } : {}),
    ...(str(account.display_name) || str(account.full_name)
      ? { displayName: (str(account.display_name) || str(account.full_name))! }
      : {}),
    ...(str(account.uuid) ? { accountUuid: str(account.uuid)! } : {}),
    ...(str(org.name) ? { organizationName: str(org.name)! } : {}),
    ...(str(org.uuid) ? { organizationUuid: str(org.uuid)! } : {}),
    ...(str(org.organization_type)
      ? { organizationType: str(org.organization_type)! }
      : {}),
    ...(str(org.rate_limit_tier)
      ? { rateLimitTier: str(org.rate_limit_tier)! }
      : {}),
    ...(str(org.subscription_status)
      ? { subscriptionStatus: str(org.subscription_status)! }
      : {}),
    ...(account.has_claude_max === true
      ? { plan: "max" as const }
      : account.has_claude_pro === true
        ? { plan: "pro" as const }
        : {}),
    fetchedAt: now,
  };
  return identity.accountUuid || identity.email ? identity : null;
}

export function getAccountIdentity(accountId?: string): AccountIdentity | null {
  return readStore().accounts[normalizeKey(accountId)] ?? null;
}

export function getAllAccountIdentities(): Record<string, AccountIdentity> {
  return readStore().accounts;
}

/** Move an account's identity to a new id (see renameAccount). */
export function renameAccountIdentity(oldId: string, newId: string): void {
  const store = readStore();
  const entry = store.accounts[normalizeKey(oldId)];
  if (!entry) return;
  delete store.accounts[normalizeKey(oldId)];
  store.accounts[normalizeKey(newId)] = entry;
  writeStore(store);
}

/** Forget an identity — used when an account is disconnected or removed. */
export function clearAccountIdentity(accountId: string): void {
  const store = readStore();
  delete store.accounts[normalizeKey(accountId)];
  writeStore(store);
}

/**
 * A label that names one login while the credential belongs to another.
 *
 * Writing this off as a cosmetic slip is how it bites: the label is the FIRST
 * thing read and the resolved login sits three lines below, so the card
 * contradicts itself and the wrong half wins. Refusing emails in new labels
 * (see `assertLabelNamesNoLogin`) does not cover the case that actually
 * happened — the label agreed with the cached identity when it was written and
 * only became a lie once the identity resolved to somebody else. So it is
 * checked on every read, against the live-resolved email, not against whatever
 * was true at write time.
 */
export function labelLoginMismatch(
  accountId: string,
  label: string,
): { claimed: string; actual: string } | null {
  const claimed = labelEmail(label || "");
  if (!claimed) return null;
  const actual = getAccountIdentity(accountId)?.email;
  // Unresolved identity is "unknown", not "mismatch": claiming a contradiction
  // we cannot prove would be the same sin in the other direction.
  if (!actual) return null;
  return claimed.toLowerCase() === actual.toLowerCase()
    ? null
    : { claimed, actual };
}

/**
 * Other accounts signed in as the SAME Claude login. Not merely the same
 * organization: two members of one Team org are genuinely separate logins with
 * separate seats, whereas the same account uuid is one login wearing two hats.
 */
export function accountsSharingLogin(accountId: string): string[] {
  const all = readStore().accounts;
  const uuid = all[normalizeKey(accountId)]?.accountUuid;
  if (!uuid) return [];
  return Object.entries(all)
    .filter(([id, i]) => id !== normalizeKey(accountId) && i.accountUuid === uuid)
    .map(([id]) => id);
}

/**
 * Resolve a profile from a raw access token, without touching any store.
 *
 * Used during a login, BEFORE credentials are written: it is the only moment
 * when a duplicate can still be refused without leaving one behind.
 */
function oauthHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-cli/2.0.0 (external, cli)",
    "x-app": "cli",
    accept: "application/json",
  };
}

/** Role of the caller in its org/workspace. Best effort — never fatal. */
async function fetchRoles(
  accessToken: string,
  signal?: AbortSignal,
): Promise<Partial<AccountIdentity>> {
  try {
    const r = await fetch(ROLES_URL, {
      headers: oauthHeaders(accessToken),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!r.ok) return {};
    const j = (await r.json()) as Record<string, unknown>;
    return {
      ...(str(j.organization_role) ? { organizationRole: str(j.organization_role)! } : {}),
      ...(str(j.workspace_name) ? { workspaceName: str(j.workspace_name)! } : {}),
      ...(str(j.workspace_role) ? { workspaceRole: str(j.workspace_role)! } : {}),
    };
  } catch {
    return {};
  }
}

export async function fetchIdentityWithToken(
  accessToken: string,
  options?: { signal?: AbortSignal },
): Promise<AccountIdentity | null> {
  const response = await fetch(PROFILE_URL, {
    headers: oauthHeaders(accessToken),
    signal: options?.signal ?? AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;
  const identity = parseProfile(await response.json().catch(() => null));
  if (!identity) return null;
  return { ...identity, ...(await fetchRoles(accessToken, options?.signal)) };
}

/** Record an identity resolved elsewhere (e.g. during a login exchange). */
export function storeAccountIdentity(
  accountId: string,
  identity: AccountIdentity,
): void {
  const store = readStore();
  store.accounts[normalizeKey(accountId)] = identity;
  writeStore(store);
}

/**
 * Accounts already signed in as the given login. Answers "am I about to
 * connect the account I am already using?" before anything is written.
 */
export function accountsWithLogin(
  accountUuid: string,
  excludeAccountId?: string,
): string[] {
  const exclude = excludeAccountId ? normalizeKey(excludeAccountId) : null;
  return Object.entries(readStore().accounts)
    .filter(([id, i]) => id !== exclude && i.accountUuid === accountUuid)
    .map(([id]) => id);
}

/**
 * Read the profile for an account. Free — no inference, no tokens spent.
 */
export async function fetchAccountIdentity(
  account: ClaudeAccount,
  options?: { signal?: AbortSignal },
): Promise<AccountIdentity> {
  const creds = readClaudeCliOAuthCredentials(
    account.configDir ? { configDir: account.configDir } : undefined,
  );
  if (!creds?.accessToken) {
    throw new Error(
      `account "${account.id}" is not connected — no credentials in ${accountConfigDir(account)}`,
    );
  }
  const response = await fetch(PROFILE_URL, {
    headers: oauthHeaders(creds.accessToken),
    signal: options?.signal ?? AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `profile lookup failed (HTTP ${response.status}): ${text.slice(0, 200)}`,
    );
  }
  const base = parseProfile(await response.json());
  if (!base) throw new Error("profile response carried no account");
  const identity: AccountIdentity = {
    ...base,
    ...(await fetchRoles(creds.accessToken, options?.signal)),
  };

  const store = readStore();
  store.accounts[normalizeKey(account.id)] = identity;
  writeStore(store);
  log.info("[opencode-claude] account identity resolved", {
    account: account.id,
    organization: identity.organizationName,
  });
  return identity;
}
