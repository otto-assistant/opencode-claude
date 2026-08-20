/**
 * Request-context headers, in their own module on purpose.
 *
 * OpenCode treats EVERY function a plugin entrypoint exports as a plugin of
 * its own: it calls each one and pushes the result into the plugin list. A
 * helper exported from `index.ts` therefore gets invoked as a hooks factory,
 * and whatever it returns — `undefined`, here — lands in that list and takes
 * the whole provider catalog down with
 * `TypeError: undefined is not an object (evaluating 'n.provider')`.
 *
 * So the entrypoint exports the plugin and nothing else; helpers live here.
 */
import { DIRECTORY_HEADER } from "./constants.js";

export function applyClaudeRequestContextHeaders(
  headers: Record<string, string>,
  directory: string,
  sessionID?: string,
): void {
  headers[DIRECTORY_HEADER] = directory;
  if (sessionID) headers["x-opencode-claude-session"] = sessionID;
}
