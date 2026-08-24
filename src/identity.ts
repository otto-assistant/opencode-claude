/**
 * Who each account actually is — resolved by the CLI, not by the plugin.
 *
 * The Agent SDK control channel's `accountInfo()` reports the login behind
 * the spawned CLI's credentials (email, organization, subscription type).
 * The plugin records what the CLI says and never reads a token itself.
 *
 * This exists because "configured" is not the same as "a different
 * subscription": two accounts whose CLI homes hold grants for the SAME
 * claude.ai login are one quota pool wearing two labels. Showing the email
 * makes that obvious instead of leaving it to be inferred.
 *
 * Store: $XDG_DATA_HOME/opencode-claude/identity.json
 * Env: OPENCODE_CLAUDE_IDENTITY_STORE overrides the path (tests).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { labelEmail } from "./accounts.js";

export type AccountIdentity = {
  email?: string;
  organization?: string;
  /** 'pro' | 'max' | 'team' | 'enterprise' as the CLI reports it. */
  subscriptionType?: string;
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

/** Parse an Agent SDK `accountInfo()` payload into a stored identity. */
export function parseAccountInfo(
  payload: unknown,
  now: number = Date.now(),
): AccountIdentity | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;
  const email = str(raw.email);
  const organization = str(raw.organization);
  const subscriptionType = str(raw.subscriptionType);
  if (!email && !organization && !subscriptionType) return null;
  return {
    ...(email ? { email } : {}),
    ...(organization ? { organization } : {}),
    ...(subscriptionType ? { subscriptionType } : {}),
    fetchedAt: now,
  };
}

export function recordAccountIdentity(
  accountId: string | undefined,
  payload: unknown,
  now: number = Date.now(),
): AccountIdentity | null {
  const parsed = parseAccountInfo(payload, now);
  if (!parsed) return null;
  const store = readStore();
  store.accounts[normalizeKey(accountId)] = parsed;
  writeStore(store);
  return parsed;
}

export function getAccountIdentity(
  accountId?: string,
): AccountIdentity | null {
  return readStore().accounts[normalizeKey(accountId)] ?? null;
}

export function clearAccountIdentity(accountId: string): void {
  const store = readStore();
  delete store.accounts[normalizeKey(accountId)];
  writeStore(store);
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

/**
 * Account ids that resolved to the same login as the given one — i.e. the
 * same subscription signed in twice. Empty when nothing is known yet.
 */
export function accountsSharingLogin(accountId: string): string[] {
  const all = readStore().accounts;
  const email = all[normalizeKey(accountId)]?.email?.toLowerCase();
  if (!email) return [];
  return Object.entries(all)
    .filter(
      ([id, identity]) =>
        id !== normalizeKey(accountId) &&
        identity.email?.toLowerCase() === email,
    )
    .map(([id]) => id);
}

/**
 * The label names a login that is not the one the CLI resolved. A slot
 * titled "Work · alice@corp.com" whose credential belongs to bob@corp.com
 * contradicts itself three lines apart — worth flagging on read, not only
 * refusing on write.
 */
export function labelLoginMismatch(
  accountId: string,
  label: string,
): { claimed: string; actual: string } | null {
  const claimed = labelEmail(label);
  if (!claimed) return null;
  const actual = getAccountIdentity(accountId)?.email;
  if (!actual) return null;
  if (claimed.toLowerCase() === actual.toLowerCase()) return null;
  return { claimed, actual };
}

/** Test helper. */
export function __resetIdentityStore(): void {
  writeStore({ version: 1, accounts: {} });
}
