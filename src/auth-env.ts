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
 * API-priority credentials so subscription auth wins.
 *
 * CLAUDE_CODE_OAUTH_TOKEN is deliberately passed through: the plugin never
 * sets or rotates it, but an operator-provided token (CI / headless hosts
 * with no on-disk CLI credentials) must reach the CLI unchanged. The CLI
 * itself decides whether to honor it.
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
