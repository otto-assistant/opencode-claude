/** Public Claude Code / OpenCode Anthropic OAuth client id (not a secret). */
export const CLIENT_ID =
  process.env.ANTHROPIC_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export const AUTHORIZE_URL =
  process.env.ANTHROPIC_AUTHORIZE_URL || "https://claude.ai/oauth/authorize";

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
