/**
 * Subscription-only child env for Claude Code (from OpenChamber harness).
 * Never log env values — this module only returns sanitized copies.
 */

/** Vars that prefer API billing over Claude Code OAuth/subscription login. */
export const API_PRIORITY_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
]);

/**
 * Build a child-process env for Claude Code subscription mode.
 * Starts from process.env (or provided base), preserves PATH, then deletes
 * API-priority credentials so subscription OAuth wins.
 */
export function buildClaudeCodeChildEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env = { ...baseEnv };
  for (const key of API_PRIORITY_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

/** Inject a subscription OAuth access token for the Claude CLI / Agent SDK. */
export function withClaudeOAuthToken(
  accessToken: string,
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env = buildClaudeCodeChildEnv(baseEnv);
  env.CLAUDE_CODE_OAUTH_TOKEN = accessToken;
  return env;
}
