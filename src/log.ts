/**
 * Debug-gated logger.
 *
 * OpenCode surfaces plugin stdout/stderr in the TUI, so stay quiet unless
 * OPENCODE_CLAUDE_DEBUG is explicitly enabled.
 */
const debugEnabled: boolean = (() => {
  const value = (process.env.OPENCODE_CLAUDE_DEBUG ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
})();

function emit(args: unknown[]): void {
  if (!debugEnabled) return;
  console.error(...args);
}

export const log = {
  info(...args: unknown[]): void {
    emit(args);
  },
  warn(...args: unknown[]): void {
    emit(args);
  },
  error(...args: unknown[]): void {
    emit(args);
  },
};
