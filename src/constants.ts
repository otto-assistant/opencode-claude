export const PROVIDER_ID = "claude-code";
export const DEFAULT_MODEL_ID = "sonnet";
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

export const EFFORT_HEADER = "x-opencode-claude-effort";
export const SESSION_HEADER = "x-opencode-claude-session";
/** Active OpenCode project directory forwarded to the local Agent SDK proxy. */
export const DIRECTORY_HEADER = "x-opencode-claude-directory";
/**
 * Claude account a response ran on. Echoed on turn responses and errors in
 * multi-account mode so the bound account is visible from the wire without
 * reading any store.
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
