/**
 * OpenCode Claude Auth Plugin
 *
 * Enables Claude Code (subscription) inside OpenCode via:
 * 1. Claude CLI credential sync or browser OAuth (Pro/Max)
 * 2. Local OpenAI-compatible proxy backed by the Claude Agent SDK
 * 3. Native effort variants, session resume, tools, skills, and MCP
 *
 * Register in opencode.json:
 *   { "plugin": ["@otto-assistant/opencode-claude"] }
 */
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  refreshClaudeToken,
  RefreshTokenInvalidError,
  type ClaudeOAuthTokens,
} from "./auth.js";
import {
  completeClaudeBrowserLogin,
  getPendingClaudeLogin,
  isCliOwnedRefreshToken,
  readStoredClaudeOAuth,
  resetPendingClaudeLogin,
  startClaudeBrowserLogin,
  syncClaudeCliCredentialsToOpenCode,
} from "./auth-login.js";
import {
  ACCOUNT_HEADER,
  DEFAULT_MODEL_ID,
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  OPENAI_COMPATIBLE_NPM,
  PROVIDER_ID,
} from "./constants.js";
import {
  configureAccounts,
  getAccounts,
  getDefaultAccount,
  isMultiAccount,
  type ClaudeAccount,
} from "./accounts.js";
import { readClaudeCliOAuthCredentials } from "./credentials.js";
import { detectClaudeCode } from "./detect.js";
import { log } from "./log.js";
import {
  encodeClaudeModelSelection,
  resolveClaudeModelSelection,
} from "./model-selection.js";
import {
  buildConfigVariants,
  buildEffortVariants,
  getClaudeModels,
  LOGIN_PLACEHOLDER_MODELS,
  type ClaudeModel,
} from "./models.js";
import {
  getClaudeProxyBaseUrl,
  getProxyPort,
  startProxy,
} from "./proxy.js";

type ClaudeOAuthAuth = {
  type: "oauth";
  access?: string;
  refresh: string;
  expires: number;
};

function isClaudeOAuthAuth(auth: unknown): auth is ClaudeOAuthAuth {
  return (
    !!auth &&
    typeof auth === "object" &&
    (auth as { type?: unknown }).type === "oauth" &&
    typeof (auth as { refresh?: unknown }).refresh === "string" &&
    typeof (auth as { expires?: unknown }).expires === "number"
  );
}

function zeroCost() {
  return {
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  };
}

export function applyClaudeRequestContextHeaders(
  headers: Record<string, string>,
  directory: string,
  sessionID?: string,
): void {
  headers[DIRECTORY_HEADER] = directory;
  if (sessionID) headers["x-opencode-claude-session"] = sessionID;
}

function buildProviderModel(
  model: ClaudeModel,
  id: string,
  baseURL: string,
): Record<string, unknown> {
  const variants = buildEffortVariants(model);
  const hasEffort = Object.values(variants).some(
    (v) => v && typeof v === "object" && "effort" in v,
  );
  return {
    id,
    providerID: PROVIDER_ID,
    api: {
      id,
      url: baseURL,
      npm: OPENAI_COMPATIBLE_NPM,
    },
    name: id === DEFAULT_MODEL_ID && model.id !== DEFAULT_MODEL_ID
      ? `Default (${model.name})`
      : model.name,
    capabilities: {
      temperature: true,
      // Runtime models expose reasoning so streams can carry thinking deltas.
      reasoning: hasEffort,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: true,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: true,
    },
    // OpenCode derives capabilities.input from modalities.input — include
    // "pdf" or PDFs are replaced with unsupported-modality errors.
    modalities: {
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
    cost: zeroCost(),
    limit: {
      context: model.contextWindow,
      output: model.maxTokens,
    },
    status: "active",
    options: {
      includeUsage: true,
    },
    headers: {},
    release_date: "",
    variants,
  };
}

function buildConfigModelEntry(model: ClaudeModel): Record<string, unknown> {
  const variants = buildConfigVariants(model);
  return {
    name: model.name,
    // Keep config non-reasoning so OpenCode does not prepend generic
    // low/medium/high ahead of our explicit effort map (cursor pattern).
    reasoning: false,
    tool_call: true,
    // OpenCode config merge sets capabilities.input from modalities.input.
    // Missing "image"/"pdf" strips attachments before they reach the proxy.
    attachment: true,
    modalities: {
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
    capabilities: {
      tools: true,
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
    limit: {
      context: model.contextWindow,
      output: model.maxTokens,
    },
    options: {
      includeUsage: true,
    },
    variants,
  };
}

function buildClaudeProviderModels(
  models: ClaudeModel[],
): Record<string, unknown> {
  const baseURL = getClaudeProxyBaseUrl();
  const providerModels = Object.fromEntries(
    models.map((model) => [model.id, buildProviderModel(model, model.id, baseURL)]),
  );
  const defaultModel =
    models.find((m) => m.id === DEFAULT_MODEL_ID) || models[0];
  if (defaultModel && !(DEFAULT_MODEL_ID in providerModels)) {
    providerModels[DEFAULT_MODEL_ID] = buildProviderModel(
      defaultModel,
      DEFAULT_MODEL_ID,
      baseURL,
    );
  }
  return providerModels;
}

function ensureClaudeProviderConfig(
  config: Record<string, any>,
  models: ClaudeModel[],
): void {
  if (!config.provider || typeof config.provider !== "object") {
    config.provider = {};
  }
  const existing = config.provider[PROVIDER_ID] ?? {};
  const existingOptions =
    existing.options && typeof existing.options === "object"
      ? existing.options
      : {};
  const existingModels =
    existing.models && typeof existing.models === "object"
      ? existing.models
      : {};

  const port = getProxyPort();
  const baseURL = port ? `http://127.0.0.1:${port}/v1` : undefined;
  const seededModels = Object.fromEntries(
    models.map((model) => [model.id, buildConfigModelEntry(model)]),
  );
  const defaultModel =
    models.find((m) => m.id === DEFAULT_MODEL_ID) || models[0];
  if (defaultModel && !(DEFAULT_MODEL_ID in seededModels)) {
    seededModels[DEFAULT_MODEL_ID] = {
      ...buildConfigModelEntry(defaultModel),
      name: `Default (${defaultModel.name})`,
    };
  }

  config.provider[PROVIDER_ID] = {
    ...existing,
    name:
      typeof existing.name === "string" && existing.name.trim()
        ? existing.name
        : "Claude Code",
    npm: existing.npm ?? OPENAI_COMPATIBLE_NPM,
    options: {
      apiKey: "claude-code-proxy",
      includeUsage: true,
      ...existingOptions,
      // Live listener URL must win over any stale pinned baseURL in user config.
      ...(baseURL ? { baseURL } : {}),
    },
    // Seeded catalog first; user-declared model entries win.
    models: {
      ...seededModels,
      ...existingModels,
    },
  };
}

/**
 * Refresh the access token a little BEFORE it dies so turns never start with
 * a token that expires mid-flight. The 8h access-token TTL itself is fixed
 * Anthropic-side; what keeps the session alive indefinitely is a refresh
 * chain that never breaks.
 */
const REFRESH_MARGIN_MS = 120_000;

/**
 * In-flight refresh dedupe, keyed by refresh token. OpenCode fires the main
 * turn and the title meta request in parallel — without single-flight both
 * refresh with the SAME token, Anthropic rotates on the first, and the
 * second dies with invalid_grant, killing the whole chain (this exact race
 * burned quota on 2026-08-11).
 */
const refreshInFlight = new Map<string, Promise<string | null>>();

/**
 * Access token for an account that owns its own Claude home.
 *
 * Deliberately read-only: the CLI living in that config dir is the sole owner
 * of its refresh chain, and rotating it from here is exactly the two-owner
 * replay that gets the whole grant revoked (see auth-login.ts). An expired
 * token yields null, which makes the proxy spawn the CLI WITHOUT
 * CLAUDE_CODE_OAUTH_TOKEN so the CLI refreshes its own credentials file.
 */
function resolveScopedAccountToken(account: ClaudeAccount): string | null {
  const creds = readClaudeCliOAuthCredentials({ configDir: account.configDir });
  if (!creds?.accessToken) return null;
  if (creds.expiresAt && creds.expiresAt <= Date.now() + 30_000) {
    log.info("[opencode-claude] account token expired; letting the CLI refresh", {
      account: account.id,
    });
    return null;
  }
  return creds.accessToken;
}

async function resolveAccessToken(
  input: PluginInput,
  getAuth: () => Promise<unknown>,
  account?: ClaudeAccount,
): Promise<string | null> {
  // Accounts pinned to their own Claude home never touch auth.json: that file
  // has exactly one `claude-code` slot, and sharing it across subscriptions
  // would hand one account's token to another.
  if (account?.configDir) return resolveScopedAccountToken(account);
  let auth = await getAuth();
  // The host's in-memory auth store can lag auth.json (tokens written by a
  // sibling process, a headless login, or a race at server start). When the
  // host hands us nothing usable, trust the fresher on-disk entry instead of
  // falling into the logged-out placeholder path.
  if (
    !isClaudeOAuthAuth(auth) ||
    !(auth.access && auth.expires > Date.now() + REFRESH_MARGIN_MS)
  ) {
    const stored = readStoredClaudeOAuth();
    if (
      stored &&
      (!isClaudeOAuthAuth(auth) || stored.expires > (auth.expires ?? 0))
    ) {
      auth = { type: "oauth", ...stored };
    }
  }
  if (isClaudeOAuthAuth(auth)) {
    if (auth.access && auth.expires > Date.now() + REFRESH_MARGIN_MS) {
      return auth.access;
    }
    // CLI-owned chains are never rotated through the token endpoint by us
    // (rotation belongs to the CLI — see isCliOwnedRefreshToken); re-sync
    // from the CLI file instead.
    if (isCliOwnedRefreshToken(auth.refresh)) {
      const synced = syncClaudeCliCredentialsToOpenCode();
      if (synced) return synced.access;
      // Only hand out the stored access token while it is genuinely valid —
      // an expired token spawns a doomed turn (401) and blocks CLI self-heal.
      return auth.access && auth.expires > Date.now() ? auth.access : null;
    }

    const key = auth.refresh;
    let pending = refreshInFlight.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const refreshed = await refreshClaudeToken(key);
          await input.client.auth.set({
            path: { id: PROVIDER_ID },
            body: {
              type: "oauth",
              refresh: refreshed.refresh,
              access: refreshed.access,
              expires: refreshed.expires,
            },
          });
          return refreshed.access;
        } catch (err) {
          const permanent = err instanceof RefreshTokenInvalidError;
          log.error(
            `[opencode-claude] token refresh ${permanent ? "rejected" : "failed"}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          if (permanent) {
            // invalid_grant usually means another actor (claude CLI, a
            // parallel refresh) rotated the token first. Re-read the store:
            // fresher credentials may already be there.
            try {
              const latest = await getAuth();
              if (
                isClaudeOAuthAuth(latest) &&
                latest.refresh !== key &&
                latest.access &&
                latest.expires > Date.now() + REFRESH_MARGIN_MS
              ) {
                log.info(
                  "[opencode-claude] recovered newer OAuth credentials after refresh rejection",
                );
                return latest.access;
              }
            } catch {
              // fall through to CLI sync
            }
            const synced = syncClaudeCliCredentialsToOpenCode();
            return synced?.access ?? null;
          }
          // Transient refresh failure: the old access token is only useful
          // while actually valid; otherwise null lets the CLI self-heal.
          return auth.access && auth.expires > Date.now()
            ? auth.access
            : null;
        }
      })();
      refreshInFlight.set(key, pending);
      const cleanup = () => {
        refreshInFlight.delete(key);
      };
      pending.then(cleanup, cleanup);
    }
    return pending;
  }

  const synced = syncClaudeCliCredentialsToOpenCode();
  if (synced) {
    try {
      await input.client.auth.set({
        path: { id: PROVIDER_ID },
        body: {
          type: "oauth",
          refresh: synced.refresh,
          access: synced.access,
          expires: synced.expires,
        },
      });
    } catch {
      // auth.set may be unavailable in some hosts
    }
    return synced.access;
  }
  return null;
}

async function loadClaudeRuntime(
  input: PluginInput,
  getAuth: () => Promise<unknown>,
  provider?: { models?: Record<string, unknown> },
): Promise<{ port: number; providerModels: Record<string, unknown> } | undefined> {
  const detection = await detectClaudeCode();
  const accessToken = await resolveAccessToken(input, getAuth);

  // In multi-account mode a non-default account can be signed in while the
  // ambient one is not, so the catalog must not collapse to the login
  // placeholder just because the default account has no token yet.
  const anyAccountReady =
    accessToken ||
    detection.loggedIn ||
    Boolean(readStoredClaudeOAuth()) ||
    getAccounts().some(
      (a) => a.configDir && resolveScopedAccountToken(a) !== null,
    );

  const models = anyAccountReady ? getClaudeModels() : LOGIN_PLACEHOLDER_MODELS;

  if (!anyAccountReady) {
    // Still seed placeholder models + a proxy so the provider stays visible.
    const port = await startProxy(async () => null);
    const providerModels = buildClaudeProviderModels(models);
    if (provider) provider.models = providerModels;
    return { port, providerModels };
  }

  const port = await startProxy(async (account) => {
    return resolveAccessToken(input, getAuth, account);
  });

  const providerModels = buildClaudeProviderModels(models);
  if (provider) provider.models = providerModels;
  return { port, providerModels };
}

/**
 * OpenCode plugin that provides Claude Code authentication and model access.
 */
export type ClaudeCodePluginOptions = {
  /**
   * Claude subscriptions to expose, each with its own CLAUDE_CONFIG_DIR:
   *   { "accounts": [
   *       { "id": "work", "label": "Work", "configDir": "~/.claude-work", "default": true },
   *       { "id": "personal", "label": "Personal", "configDir": "~/.claude-personal" }
   *   ] }
   * Omit it entirely for the classic single-subscription behaviour.
   */
  accounts?: unknown;
};

export const ClaudeCodePlugin: Plugin = async (
  input: PluginInput,
  options?: ClaudeCodePluginOptions,
): Promise<Hooks> => {
  // Resolve the account registry before anything reads it: the model catalog,
  // the proxy and the credential probes all key off it.
  configureAccounts(options?.accounts);

  // Best-effort CLI sync on load so OpenChamber / headless hosts work without
  // an explicit auth.methods click when `claude` is already logged in.
  try {
    syncClaudeCliCredentialsToOpenCode();
  } catch (err) {
    log.warn(
      "[opencode-claude] CLI credential sync skipped",
      err instanceof Error ? err.message : err,
    );
  }

  return {
    async config(config) {
      const detection = await detectClaudeCode();
      // Model visibility must not depend on the CLI's login state alone: a
      // valid plugin-owned OAuth entry in auth.json is just as logged-in.
      // (After a CLI logout the catalog collapsed to login+sonnet and the
      // provider looked broken despite a fresh plugin OAuth token.)
      const hasStoredAuth = Boolean(readStoredClaudeOAuth());
      const hasScopedAccount = getAccounts().some(
        (a) => a.configDir && resolveScopedAccountToken(a) !== null,
      );
      const models =
        detection.loggedIn ||
        detection.status === "ready" ||
        hasStoredAuth ||
        hasScopedAccount
          ? getClaudeModels()
          : LOGIN_PLACEHOLDER_MODELS;

      // Bind first (ephemeral port by default), then seed provider baseURL so
      // OpenCode's static config matches the live listener for this process.
      try {
        await startProxy(async (account) => {
          if (account.configDir) {
            // Scoped accounts never consult the host auth store.
            return resolveAccessToken(input, async () => null, account);
          }
          try {
            const authClient = input.client.auth as {
              get?: (args: { path: { id: string } }) => Promise<unknown>;
            };
            if (typeof authClient.get === "function") {
              const auth = await authClient.get({ path: { id: PROVIDER_ID } });
              const payload =
                auth && typeof auth === "object" && "data" in auth
                  ? (auth as { data: unknown }).data
                  : auth;
              return resolveAccessToken(input, async () => payload, account);
            }
          } catch {
            // ignore
          }
          // Browser OAuth belongs to this plugin and is persisted in
          // auth.json. The host's auth client may not yet reflect that file
          // (notably during OpenChamber's provider-page reauthentication),
          // so use the normal resolver with an empty host response. It
          // falls back to the on-disk `claude-code` entry before considering
          // the optional Claude CLI credentials.
          return resolveAccessToken(input, async () => null, account);
        });
      } catch (err) {
        log.error(
          "[opencode-claude] proxy failed to start during config",
          err instanceof Error ? err.message : err,
        );
      }

      ensureClaudeProviderConfig(config as Record<string, any>, models);
    },

    "chat.headers": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      const messageModel = hookInput.message.model as {
        variant?: unknown;
      };
      const variant =
        typeof messageModel.variant === "string"
          ? messageModel.variant
          : undefined;
      // The chosen model id carries the account (`opus@work`); the selection
      // splits it so the proxy gets both without a second switch to keep in
      // sync with the picker.
      const selected = resolveClaudeModelSelection(hookInput.model.id, variant);
      output.headers[EFFORT_HEADER] = encodeClaudeModelSelection(selected);
      if (selected.account) {
        output.headers[ACCOUNT_HEADER] = selected.account;
      }
      // The proxy runs in the long-lived OpenCode server process, whose cwd is
      // commonly the service account home (for example /home/ubuntu), not the
      // project attached to this plugin instance. Carry the authoritative
      // PluginInput directory on every request so Claude Code loads the right
      // project files, settings, and AGENTS.md.
      applyClaudeRequestContextHeaders(
        output.headers,
        input.directory,
        hookInput.sessionID,
      );
    },

    "chat.params": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      delete output.options.reasoningEffort;
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider, ctx) {
        const runtime = await loadClaudeRuntime(
          input,
          async () => ctx.auth,
          provider,
        );
        return (runtime?.providerModels ?? {}) as Record<string, any>;
      },
    },

    auth: {
      provider: PROVIDER_ID,

      async loader(getAuth, provider) {
        const runtime = await loadClaudeRuntime(input, getAuth, provider);
        if (!runtime) return {};

        return {
          baseURL: `http://127.0.0.1:${runtime.port}/v1`,
          apiKey: "claude-code-proxy",
          async fetch(
            requestInput: RequestInfo | URL,
            init?: RequestInit,
          ) {
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization");
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([key]) => key.toLowerCase() !== "authorization",
                );
              } else {
                delete (init.headers as Record<string, string>).authorization;
                delete (init.headers as Record<string, string>).Authorization;
              }
            }
            return fetch(requestInput, init);
          },
        };
      },

      methods: [
        {
          type: "oauth",
          label: "Use Claude Code CLI login",
          async authorize() {
            const synced = syncClaudeCliCredentialsToOpenCode();
            if (synced) {
              return {
                url: "https://docs.anthropic.com/en/docs/claude-code",
                instructions:
                  "Claude Code CLI credentials were found and synced. Click Complete to finish.",
                method: "auto" as const,
                async callback() {
                  return {
                    type: "success" as const,
                    refresh: synced.refresh,
                    access: synced.access,
                    expires: synced.expires,
                  };
                },
              };
            }

            return {
              url: "https://docs.anthropic.com/en/docs/claude-code",
              instructions:
                "Run `claude auth login` in a terminal, then click Complete. Or choose browser OAuth instead.",
              method: "auto" as const,
              async callback() {
                const again = syncClaudeCliCredentialsToOpenCode();
                if (!again) {
                  return {
                    type: "failed" as const,
                  };
                }
                return {
                  type: "success" as const,
                  refresh: again.refresh,
                  access: again.access,
                  expires: again.expires,
                };
              },
            };
          },
        },
        {
          type: "oauth",
          label: "Login with Claude Pro/Max",
          async authorize() {
            let pending = getPendingClaudeLogin();
            if (!pending || pending.completed) {
              pending = await startClaudeBrowserLogin();
            }

            return {
              url: pending.url,
              instructions:
                "Open the URL, approve access, then paste the redirect URL (or code#state) and click Complete.",
              method: "code" as const,
              async callback(code: string) {
                try {
                  const tokens = await completeClaudeBrowserLogin(code);
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh,
                    access: tokens.access,
                    expires: tokens.expires,
                  };
                } catch (err) {
                  resetPendingClaudeLogin();
                  log.error(
                    "[opencode-claude] OAuth callback failed",
                    err instanceof Error ? err.message : err,
                  );
                  return { type: "failed" as const };
                }
              },
            };
          },
        },
      ],
    },
  };
};

export default ClaudeCodePlugin;

export type { ClaudeOAuthTokens };
export { detectClaudeCode } from "./detect.js";
export { getClaudeModels, CLAUDE_CODE_MODELS } from "./models.js";
export { startProxy, stopProxy, getClaudeProxyBaseUrl } from "./proxy.js";
