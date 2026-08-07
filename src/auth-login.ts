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
  // Also seed anthropic so stock Anthropic provider UIs can see a session
  // without clobbering an existing API-key entry.
  const anthropic = existing.anthropic;
  if (
    !anthropic ||
    (typeof anthropic === "object" &&
      (anthropic as { type?: string }).type === "oauth")
  ) {
    existing.anthropic = {
      type: "oauth",
      refresh: tokens.refresh,
      access: tokens.access,
      expires: tokens.expires,
    };
  }
  writeAuthFile(existing);
}

/**
 * Sync Claude CLI subscription credentials into OpenCode auth.json.
 * Returns tokens when available, otherwise null.
 */
export function syncClaudeCliCredentialsToOpenCode(): ClaudeOAuthTokens | null {
  const creds = readClaudeCliOAuthCredentials();
  if (!creds?.accessToken) return null;

  const expires =
    creds.expiresAt && creds.expiresAt > Date.now()
      ? creds.expiresAt
      : Date.now() + 60 * 60 * 1000;

  const tokens: ClaudeOAuthTokens = {
    access: creds.accessToken,
    refresh: creds.refreshToken || `cli-sync-${creds.source}`,
    expires,
  };

  writeClaudeAuth(tokens);
  log.info("[opencode-claude] synced Claude CLI credentials into OpenCode auth");
  return tokens;
}

export function getPendingClaudeLogin(): PendingClaudeLogin | null {
  return pending;
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
