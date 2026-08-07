/**
 * Read Claude Code CLI subscription OAuth credentials.
 * Resolution: CLAUDE_CODE_OAUTH_TOKEN env → macOS Keychain → credentials files.
 * Never log token values.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ClaudeCliOAuthCredentials = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[] | null;
  source: "env" | "keychain" | "credentials-file";
  credentialsPath?: string;
};

function toExpiresAtMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function extractFromBlock(
  block: Record<string, unknown>,
): Omit<ClaudeCliOAuthCredentials, "source" | "credentialsPath"> | null {
  const accessToken =
    (typeof block.accessToken === "string" && block.accessToken) ||
    (typeof block.access_token === "string" && block.access_token) ||
    "";
  if (!accessToken.trim()) return null;

  const refreshToken =
    (typeof block.refreshToken === "string" && block.refreshToken) ||
    (typeof block.refresh_token === "string" && block.refresh_token) ||
    null;

  const expiresAt =
    toExpiresAtMs(block.expiresAt) ?? toExpiresAtMs(block.expires_at);

  let scopes: string[] | null = null;
  if (Array.isArray(block.scopes)) {
    scopes = block.scopes.filter((s): s is string => typeof s === "string");
  }

  return {
    accessToken: accessToken.trim(),
    refreshToken: refreshToken ? refreshToken.trim() : null,
    expiresAt,
    scopes,
  };
}

export function extractClaudeOAuthCredentials(
  parsed: unknown,
): Omit<ClaudeCliOAuthCredentials, "source" | "credentialsPath"> | null {
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const block =
    (root.claudeAiOauth && typeof root.claudeAiOauth === "object"
      ? (root.claudeAiOauth as Record<string, unknown>)
      : null) ||
    (root.claude_ai_oauth && typeof root.claude_ai_oauth === "object"
      ? (root.claude_ai_oauth as Record<string, unknown>)
      : null);
  if (!block) return null;
  return extractFromBlock(block);
}

export function listClaudeCredentialsCandidates(
  homeDir = homedir(),
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string[] {
  const candidates: string[] = [];
  const configDir =
    typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  if (configDir) {
    candidates.push(join(configDir, ".credentials.json"));
    candidates.push(join(configDir, "credentials.json"));
  }
  candidates.push(
    join(homeDir, ".claude", ".credentials.json"),
    join(homeDir, ".claude", "credentials.json"),
    join(homeDir, ".config", "claude", ".credentials.json"),
  );
  return candidates;
}

function readFromKeychain(): ClaudeCliOAuthCredentials | null {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (!raw) return null;
    const extracted = extractClaudeOAuthCredentials(JSON.parse(raw));
    if (!extracted) return null;
    return { ...extracted, source: "keychain" };
  } catch {
    return null;
  }
}

function readFromFiles(
  homeDir = homedir(),
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ClaudeCliOAuthCredentials | null {
  for (const path of listClaudeCredentialsCandidates(homeDir, env)) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8");
      const extracted = extractClaudeOAuthCredentials(JSON.parse(raw));
      if (!extracted) continue;
      return { ...extracted, source: "credentials-file", credentialsPath: path };
    } catch {
      // try next
    }
  }
  return null;
}

export function readClaudeCodeOAuthTokenFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | null {
  const value = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readClaudeCliOAuthCredentials(options?: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): ClaudeCliOAuthCredentials | null {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? homedir();

  const fromEnv = readClaudeCodeOAuthTokenFromEnv(env);
  if (fromEnv) {
    return {
      accessToken: fromEnv,
      refreshToken: null,
      expiresAt: null,
      scopes: null,
      source: "env",
    };
  }

  return readFromKeychain() ?? readFromFiles(homeDir, env);
}

export function hasClaudeCliOAuthCredentials(options?: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): boolean {
  return Boolean(readClaudeCliOAuthCredentials(options)?.accessToken);
}
