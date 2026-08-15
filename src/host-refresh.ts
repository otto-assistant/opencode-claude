/**
 * Nudge the host into rebuilding its model catalog.
 *
 * OpenCode builds the provider catalog once and caches it, so an account that
 * was renamed, added or removed keeps its old name in the model picker — the
 * label rides inside the model name, and nothing tells the host it changed.
 * There is no reload endpoint, but an empty `PATCH /config` makes OpenCode
 * re-run the plugin's config hook, which rebuilds the catalog from the current
 * registry. Verified against a live server: after the patch the picker shows
 * renamed accounts and newly added ones.
 *
 * Registered from the plugin factory, which is the only place holding the
 * host client; everything else calls `refreshHostCatalog()` and does not care.
 */
import { log } from "./log.js";

type Refresher = () => Promise<void>;

let refresher: Refresher | null = null;

export function setHostCatalogRefresher(fn: Refresher | null): void {
  refresher = fn;
}

/**
 * Best effort by design: an account change must not fail because the host
 * would not re-read its config. The worst case is a stale picker until the
 * next restart, which is where we were before.
 */
export async function refreshHostCatalog(): Promise<void> {
  if (!refresher) return;
  try {
    await refresher();
  } catch (err) {
    log.warn("[opencode-claude] could not refresh the host model catalog", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
