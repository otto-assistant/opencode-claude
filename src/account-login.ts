/**
 * Browser OAuth that connects ONE account, from the panel.
 *
 * Credentials are written in Claude CLI format (`claudeAiOauth`) into that
 * account's CLAUDE_CONFIG_DIR. From the first turn onward the spawned CLI owns
 * and rotates that refresh chain; this module never refreshes it. The handoff
 * is one-directional and there is never more than one owner at a time — the
 * property that keeps Anthropic from revoking the grant for replay (see
 * auth-login.ts).
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountConfigDir,
  getAccounts,
  type ClaudeAccount,
} from "./accounts.js";
import { authorizeClaudeMax, exchangeClaudeCode } from "./auth.js";
import {
  accountsWithLogin,
  fetchAccountIdentity,
  fetchIdentityWithToken,
  storeAccountIdentity,
  type AccountIdentity,
} from "./identity.js";
import { OAUTH_SCOPES } from "./constants.js";
import { log } from "./log.js";

export type PendingAccountLogin = {
  accountId: string;
  url: string;
  state: string;
  verifier: string;
  redirectUri: string;
  /** False when the browser will redirect back to the loopback listener. */
  manual: boolean;
  startedAt: number;
};

/** One pending login per account — restarting simply replaces it. */
const pending = new Map<string, PendingAccountLogin>();

/** Abandon logins nobody completed, so a stale verifier cannot be reused. */
const LOGIN_TTL_MS = 15 * 60 * 1000;

function sweep(now = Date.now()): void {
  for (const [id, entry] of pending) {
    if (now - entry.startedAt > LOGIN_TTL_MS) pending.delete(id);
  }
}

export async function startAccountLogin(
  account: ClaudeAccount,
  options?: { redirectUri?: string },
): Promise<PendingAccountLogin> {
  sweep();
  const auth = await authorizeClaudeMax(
    options?.redirectUri ? { redirectUri: options.redirectUri } : undefined,
  );
  const entry: PendingAccountLogin = {
    accountId: account.id,
    url: auth.url,
    state: auth.state,
    verifier: auth.verifier,
    redirectUri: auth.redirectUri,
    manual: auth.manual,
    startedAt: Date.now(),
  };
  pending.set(account.id, entry);
  log.info("[opencode-claude] account login started", { account: account.id });
  return entry;
}

export function getPendingAccountLogin(
  accountId: string,
): PendingAccountLogin | undefined {
  sweep();
  return pending.get(accountId);
}

export function cancelAccountLogin(accountId: string): void {
  pending.delete(accountId);
}

/**
 * Find the login a loopback callback belongs to. The callback arrives on a
 * shared listener with no account in the path, so `state` is the only link —
 * which is exactly what it is for.
 */
export function findPendingLoginByState(
  state: string,
): PendingAccountLogin | undefined {
  sweep();
  for (const entry of pending.values()) {
    if (entry.state === state) return entry;
  }
  return undefined;
}

function credentialsPath(account: ClaudeAccount): string {
  return join(accountConfigDir(account), ".credentials.json");
}

/**
 * Write CLI-format credentials, preserving anything else already in the file.
 * Mode 0600: this is a live subscription token.
 */
export function writeAccountCredentials(
  account: ClaudeAccount,
  tokens: { access: string; refresh: string; expires: number },
): string {
  const dir = accountConfigDir(account);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = credentialsPath(account);
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object") {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // first login for this account
  }
  existing.claudeAiOauth = {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: tokens.expires,
    scopes: OAUTH_SCOPES.split(" "),
  };
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort — the file is inside a 0700 dir
  }
  return path;
}

/**
 * A login that turned out to re-authorize an account already connected here.
 * The tokens are held (not written) so the operator can still commit them
 * deliberately — an authorization code is single-use, so discarding them would
 * force a whole new round trip just to say "yes, I meant it".
 */
export class DuplicateLoginError extends Error {
  status = 409;
  code = "duplicate_login";
  email?: string;
  duplicateOf: string[];
  constructor(duplicateOf: string[], email?: string) {
    super(
      `This is the same Claude login as ${duplicateOf.join(", ")}${
        email ? ` (${email})` : ""
      } — it shares one quota pool, so it adds no capacity. Sign out of claude.ai or use a private window to connect a different account.`,
    );
    this.name = "DuplicateLoginError";
    this.duplicateOf = duplicateOf;
    if (email) this.email = email;
  }
}

type HeldLogin = {
  tokens: { access: string; refresh: string; expires: number };
  identity: AccountIdentity | null;
  heldAt: number;
};

/** Exchanged-but-unwritten tokens, awaiting an explicit "connect anyway". */
const held = new Map<string, HeldLogin>();
const HOLD_TTL_MS = 10 * 60 * 1000;

function sweepHeld(now = Date.now()): void {
  for (const [id, entry] of held) {
    if (now - entry.heldAt > HOLD_TTL_MS) held.delete(id);
  }
}

export function getHeldLogin(accountId: string): HeldLogin | undefined {
  sweepHeld();
  return held.get(accountId);
}

export function discardHeldLogin(accountId: string): void {
  held.delete(accountId);
}

/**
 * Finish a login.
 *
 * The duplicate check runs between the token exchange and the disk write,
 * which is the only point where refusing costs nothing: once credentials land,
 * the operator has a connected account to clean up. `allowDuplicate` commits
 * tokens that were held back by an earlier attempt.
 */
export async function completeAccountLogin(
  account: ClaudeAccount,
  callbackInput: string,
  options?: { allowDuplicate?: boolean },
): Promise<{
  credentialsPath: string;
  expiresAt: number;
  identity: AccountIdentity | null;
}> {
  const entry = pending.get(account.id);
  if (!entry) {
    throw new Error(
      `No login in progress for "${account.id}" — start one first (they expire after 15 minutes).`,
    );
  }
  const tokens = await exchangeClaudeCode(
    callbackInput,
    entry.verifier,
    entry.state,
    entry.redirectUri,
  );

  // Ask who this actually is before writing anything. The consent screen is
  // approved by whatever claude.ai session the browser holds and never offers
  // an account picker, so "connect another account" routinely re-authorizes
  // the current one.
  let identity: AccountIdentity | null = null;
  try {
    identity = await fetchIdentityWithToken(tokens.access);
  } catch (err) {
    log.warn("[opencode-claude] identity check during login failed", {
      account: account.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (identity?.accountUuid && !options?.allowDuplicate) {
    // Re-resolve the other accounts against Anthropic before comparing.
    // The cached identity goes stale the moment a Claude home is re-logged
    // behind our back — which is exactly how a duplicate slipped through
    // once: the cache still named the previous owner of that config dir, so
    // the uuids differed and the check passed. The profile call is free.
    await refreshOtherIdentities(account.id);
    const duplicates = accountsWithLogin(identity.accountUuid, account.id);
    if (duplicates.length > 0) {
      held.set(account.id, { tokens, identity, heldAt: Date.now() });
      pending.delete(account.id);
      log.warn("[opencode-claude] refused a duplicate login", {
        account: account.id,
        duplicateOf: duplicates,
      });
      throw new DuplicateLoginError(duplicates, identity.email);
    }
  }

  return commitAccountLogin(account, tokens, identity);
}

/**
 * Refresh the stored identity of every OTHER connected account. Failures are
 * ignored per account: an unreachable profile must not block a login, and a
 * stale entry is no worse than the one already there.
 */
async function refreshOtherIdentities(excludeAccountId: string): Promise<void> {
  await Promise.all(
    getAccounts()
      .filter((a) => a.id !== excludeAccountId)
      .map((a) => fetchAccountIdentity(a).catch(() => null)),
  );
}

function commitAccountLogin(
  account: ClaudeAccount,
  tokens: { access: string; refresh: string; expires: number },
  identity: AccountIdentity | null,
): { credentialsPath: string; expiresAt: number; identity: AccountIdentity | null } {
  const path = writeAccountCredentials(account, tokens);
  if (identity) storeAccountIdentity(account.id, identity);
  pending.delete(account.id);
  held.delete(account.id);
  log.info("[opencode-claude] account connected", {
    account: account.id,
    credentialsPath: path,
  });
  return { credentialsPath: path, expiresAt: tokens.expires, identity };
}

/**
 * Commit a login that was held back as a duplicate. Deliberate opt-in: the
 * operator has been told it shares a quota pool.
 */
export function confirmHeldLogin(account: ClaudeAccount): {
  credentialsPath: string;
  expiresAt: number;
  identity: AccountIdentity | null;
} {
  const entry = held.get(account.id);
  if (!entry) {
    throw new Error(
      `Nothing held for "${account.id}" — start the login again (held logins expire after 10 minutes).`,
    );
  }
  return commitAccountLogin(account, entry.tokens, entry.identity);
}

/** Disconnect: drop the OAuth block, keep the rest of the account's home. */
export function clearAccountCredentials(account: ClaudeAccount): void {
  const path = credentialsPath(account);
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object") {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    return; // nothing stored
  }
  delete existing.claudeAiOauth;
  delete existing.claude_ai_oauth;
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", "utf8");
  log.info("[opencode-claude] account disconnected", { account: account.id });
}
