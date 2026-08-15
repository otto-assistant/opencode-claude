/** Public Claude Code / OpenCode Anthropic OAuth client id (not a secret). */
export const CLIENT_ID =
  process.env.ANTHROPIC_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export const AUTHORIZE_URL =
  process.env.ANTHROPIC_AUTHORIZE_URL || "https://claude.ai/oauth/authorize";

/**
 * Loopback callback path. The Claude Code OAuth client publishes exactly two
 * redirect_uris — http://localhost/callback and http://127.0.0.1/callback — so
 * a loopback listener is the only way to close the loop automatically. No
 * public URL can be used: the client belongs to Anthropic and nothing else is
 * registered. It is also unnecessary — the redirect happens in the operator's
 * browser, never from Anthropic's servers.
 */
export const LOOPBACK_CALLBACK_PATH = "/callback";

export const MANUAL_REDIRECT_URL =
  process.env.ANTHROPIC_MANUAL_REDIRECT_URL ||
  "https://platform.claude.com/oauth/code/callback";

export const TOKEN_URL =
  process.env.ANTHROPIC_TOKEN_URL ||
  "https://platform.claude.com/v1/oauth/token";

export const OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
].join(" ");

export const PROVIDER_ID = "claude-code";
export const DEFAULT_MODEL_ID = "sonnet";
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

export const EFFORT_HEADER = "x-opencode-claude-effort";
export const SESSION_HEADER = "x-opencode-claude-session";
/** Active OpenCode project directory forwarded to the local Agent SDK proxy. */
export const DIRECTORY_HEADER = "x-opencode-claude-directory";
/**
 * Claude account this turn belongs to. Set on the way in when the operator
 * runs several subscriptions, echoed on every response so the bound account is
 * visible from the wire without reading any store.
 */
export const ACCOUNT_HEADER = "x-opencode-claude-account";

/** Separates a model id from its account: `opus@work`. */
export const ACCOUNT_MODEL_SEPARATOR = "@";

export const EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ClaudeEffort = (typeof EFFORT_LEVELS)[number];

export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}
