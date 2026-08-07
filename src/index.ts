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
  resetPendingClaudeLogin,
  startClaudeBrowserLogin,
  syncClaudeCliCredentialsToOpenCode,
} from "./auth-login.js";
import {
  DEFAULT_MODEL_ID,
  EFFORT_HEADER,
  OPENAI_COMPATIBLE_NPM,
  PROVIDER_ID,
} from "./constants.js";
import { detectClaudeCode } from "./detect.js";
import { log } from "./log.js";
import {
  encodeClaudeModelSelection,
  resolveClaudeModelSelection,
} from "./model-selection.js";
import {
  buildEffortVariants,
  getClaudeModels,
  isLoginPlaceholderModel,
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

function buildProviderModel(
  model: ClaudeModel,
  id: string,
  baseURL: string,
): Record<string, unknown> {
  const variants = buildEffortVariants(model);
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
      reasoning: model.reasoning && Object.keys(variants).length > 0,
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
    modalities: {
      input: ["text", "image"],
      output: ["text"],
    },
    cost: zeroCost(),
    limit: {
      context: model.contextWindow,
      output: model.maxTokens,
    },
    status: isLoginPlaceholderModel(id) ? "active" : "active",
    options: {
      includeUsage: true,
    },
    headers: {},
    release_date: "",
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
  const existing = config.provider[PROVIDER_ID];
  if (existing && typeof existing === "object" && existing.models) {
    return;
  }

  const baseURL = getClaudeProxyBaseUrl();
  config.provider[PROVIDER_ID] = {
    name: "Claude Code",
    npm: OPENAI_COMPATIBLE_NPM,
    options: {
      baseURL,
      apiKey: "claude-code-proxy",
    },
    models: Object.fromEntries(
      models.map((model) => [
        model.id,
        {
          name: model.name,
          limit: {
            context: model.contextWindow,
            output: model.maxTokens,
          },
          modalities: { input: ["text", "image"], output: ["text"] },
        },
      ]),
    ),
    ...(existing && typeof existing === "object" ? existing : {}),
  };
}

async function resolveAccessToken(
  input: PluginInput,
  getAuth: () => Promise<unknown>,
): Promise<string | null> {
  const auth = await getAuth();
  if (isClaudeOAuthAuth(auth)) {
    if (auth.access && auth.expires > Date.now() + 30_000) {
      return auth.access;
    }
    // CLI-synced placeholder refresh tokens cannot hit the token endpoint.
    if (auth.refresh.startsWith("cli-sync-")) {
      const synced = syncClaudeCliCredentialsToOpenCode();
      return synced?.access ?? auth.access ?? null;
    }
    try {
      const refreshed = await refreshClaudeToken(auth.refresh);
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
        const synced = syncClaudeCliCredentialsToOpenCode();
        return synced?.access ?? null;
      }
      return auth.access ?? null;
    }
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

  const models =
    accessToken || detection.loggedIn
      ? getClaudeModels()
      : LOGIN_PLACEHOLDER_MODELS;

  if (!accessToken && !detection.loggedIn) {
    // Still seed placeholder models + a proxy so the provider stays visible.
    await startProxy(async () => null);
    const providerModels = buildClaudeProviderModels(models);
    if (provider) provider.models = providerModels;
    return { port: getProxyPort() ?? 8787, providerModels };
  }

  const port = await startProxy(async () => {
    return resolveAccessToken(input, getAuth);
  });

  const providerModels = buildClaudeProviderModels(models);
  if (provider) provider.models = providerModels;
  return { port, providerModels };
}

/**
 * OpenCode plugin that provides Claude Code authentication and model access.
 */
export const ClaudeCodePlugin: Plugin = async (
  input: PluginInput,
): Promise<Hooks> => {
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
      const models =
        detection.loggedIn || detection.status === "ready"
          ? getClaudeModels()
          : LOGIN_PLACEHOLDER_MODELS;
      ensureClaudeProviderConfig(config as Record<string, any>, models);

      // Start proxy early so static baseURL hits a live listener.
      await startProxy(async () => {
        try {
          // Prefer live OpenCode auth store; fall back to CLI sync.
          const authClient = input.client.auth as {
            get?: (args: { path: { id: string } }) => Promise<unknown>;
          };
          if (typeof authClient.get === "function") {
            const auth = await authClient.get({ path: { id: PROVIDER_ID } });
            const payload =
              auth && typeof auth === "object" && "data" in auth
                ? (auth as { data: unknown }).data
                : auth;
            return resolveAccessToken(input, async () => payload);
          }
        } catch {
          // ignore
        }
        const synced = syncClaudeCliCredentialsToOpenCode();
        return synced?.access ?? null;
      });
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
      const selected = resolveClaudeModelSelection(hookInput.model.id, variant);
      output.headers[EFFORT_HEADER] = encodeClaudeModelSelection(selected);
      if (hookInput.sessionID) {
        output.headers["x-opencode-claude-session"] = hookInput.sessionID;
      }
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
          baseURL: getClaudeProxyBaseUrl(),
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
