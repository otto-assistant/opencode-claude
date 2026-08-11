/**
 * Auth helpers: sync Claude CLI credentials into OpenCode auth.json,
 * plus browser OAuth for hosts that do not auto-read the CLI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  authorizeClaudeMax,
  exchangeClaudeCode,
  type ClaudeOAuthTokens,
} from "./auth.js";
import { readClaudeCliOAuthCredentials } from "./credentials.js";
import { PROVIDER_ID } from "./constants.js";
import { log } from "./log.js";

export type PendingClaudeLogin = {
  url: string;
  state: string;
  verifier: string;
  redirectUri: string;
  startedAt: number;
  completed: boolean;
  error?: string;
};

let pending: PendingClaudeLogin | null = null;

/**
 * Refresh-token ownership tags.
 *
 * Anthropic rotates the refresh token on every use. A chain with TWO owners
 * (this plugin AND the claude CLI, or the plugin AND OpenCode's stock
 * anthropic provider) dies: one owner rotates, the other's next refresh
 * replays the stale token, and the server treats replay as token theft —
 * revoking the WHOLE grant (observed 2026-08-11: a re-login was revoked
 * within ~40 minutes after parallel refreshes).
 *
 * CLI-synced chains stay owned by the CLI: they are prefixed and are NEVER
 * refreshed through the token endpoint by us — we re-read the CLI file and
 * let the CLI rotate its own chain.
 */
export const CLI_SHARED_REFRESH_PREFIX = "cli-shared-";
export const CLI_SYNC_REFRESH_PREFIX = "cli-sync-";

export function isCliOwnedRefreshToken(refresh: string): boolean {
  return (
    refresh.startsWith(CLI_SHARED_REFRESH_PREFIX) ||
    refresh.startsWith(CLI_SYNC_REFRESH_PREFIX)
  );
}

function authJsonPath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode", "auth.json");
}

function readAuthFile(): Record<string, unknown> {
  const path = authJsonPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeAuthFile(data: Record<string, unknown>): void {
  const path = authJsonPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function writeClaudeAuth(tokens: ClaudeOAuthTokens): void {
  const existing = readAuthFile();
  existing[PROVIDER_ID] = {
    type: "oauth",
    refresh: tokens.refresh,
    access: tokens.access,
    expires: tokens.expires,
  };
  // Deliberately NOT seeding the stock "anthropic" provider with the same
  // tokens: two providers refreshing one chain race on rotation and get the
  // whole grant revoked for token-reuse. One chain — one owner.
  writeAuthFile(existing);
}

/**
 * Sync Claude CLI subscription credentials into OpenCode auth.json.
 * Returns tokens when available, otherwise null.
 *
 * Two poisoning guards (regression: a dead sync once clobbered healthy
 * OAuth creds and every turn then failed with 401 until manual re-login):
 * 1. An EXPIRED CLI access token is never synced. Passing it on would put a
 *    dead token into CLAUDE_CODE_OAUTH_TOKEN, which overrides the CLI's own
 *    credentials file and blocks the CLI's built-in auto-refresh — a
 *    guaranteed 401 with no self-heal. Better to sync nothing and let the
 *    spawned CLI refresh its own credentials.
 * 2. Never overwrite a NEWER existing auth.json entry (e.g. a fresh browser
 *    OAuth login) with older CLI creds.
 */
export function syncClaudeCliCredentialsToOpenCode(options?: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): ClaudeOAuthTokens | null {
  const creds = readClaudeCliOAuthCredentials(options);
  if (!creds?.accessToken) return null;

  const now = Date.now();
  if (creds.expiresAt && creds.expiresAt <= now + 30_000) {
    log.warn(
      "[opencode-claude] CLI credentials expired; not syncing a dead token into OpenCode auth",
    );
    return null;
  }

  const expires = creds.expiresAt ?? now + 60 * 60 * 1000;

  const existing = readAuthFile()[PROVIDER_ID];
  if (
    existing &&
    typeof existing === "object" &&
    (existing as { type?: unknown }).type === "oauth" &&
    typeof (existing as { access?: unknown }).access === "string" &&
    (existing as { access?: string }).access !== creds.accessToken &&
    typeof (existing as { expires?: unknown }).expires === "number" &&
    (existing as { expires: number }).expires > expires
  ) {
    log.info(
      "[opencode-claude] kept newer OpenCode auth entry over older CLI credentials",
    );
    return null;
  }

  const tokens: ClaudeOAuthTokens = {
    access: creds.accessToken,
    // Tag CLI-owned chains so we never rotate them ourselves (see
    // isCliOwnedRefreshToken) — the CLI stays the sole owner of its chain.
    refresh: creds.refreshToken
      ? `${CLI_SHARED_REFRESH_PREFIX}${creds.refreshToken}`
      : `${CLI_SYNC_REFRESH_PREFIX}${creds.source}`,
    expires,
  };

  writeClaudeAuth(tokens);
  log.info("[opencode-claude] synced Claude CLI credentials into OpenCode auth");
  return tokens;
}

export function getPendingClaudeLogin(): PendingClaudeLogin | null {
  return pending;
}

/**
 * Read the plugin's own OAuth entry straight from auth.json on disk.
 * Shape-only check — no expiry requirement (callers may still refresh).
 * This bypasses the host's in-memory auth store, which can lag the file
 * (e.g. tokens written by a sibling process or a headless login flow).
 */
export function readStoredClaudeOAuth(): ClaudeOAuthTokens | null {
  const entry = readAuthFile()[PROVIDER_ID];
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (e.type !== "oauth") return null;
  if (typeof e.access !== "string" || !e.access) return null;
  if (typeof e.refresh !== "string" || !e.refresh) return null;
  if (typeof e.expires !== "number" || !Number.isFinite(e.expires)) return null;
  return { access: e.access, refresh: e.refresh, expires: e.expires };
}

export function resetPendingClaudeLogin(): void {
  pending = null;
}

export async function startClaudeBrowserLogin(): Promise<PendingClaudeLogin> {
  const auth = await authorizeClaudeMax();
  pending = {
    url: auth.url,
    state: auth.state,
    verifier: auth.verifier,
    redirectUri: auth.redirectUri,
    startedAt: Date.now(),
    completed: false,
  };
  log.info("[opencode-claude] Claude OAuth URL ready");
  return pending;
}

export async function completeClaudeBrowserLogin(
  callbackInput: string,
): Promise<ClaudeOAuthTokens> {
  if (!pending) {
    throw new Error("No Claude login in progress — start auth first.");
  }
  const tokens = await exchangeClaudeCode(
    callbackInput,
    pending.verifier,
    pending.state,
    pending.redirectUri,
  );
  writeClaudeAuth(tokens);
  pending.completed = true;
  return tokens;
}
