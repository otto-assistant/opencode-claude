/**
 * Local OpenAI-compatible proxy → Claude Agent SDK.
 *
 * Accepts POST /v1/chat/completions, runs Claude Code via the Agent SDK
 * (OpenChamber harness approach), streams OpenAI-format SSE.
 *
 * Tool calls from OpenCode are exposed as an in-process MCP server. When Claude
 * invokes one, the stream parks (Cursor bridge-pool pattern) and returns
 * tool_calls; the follow-up request with tool results resumes the turn.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname as dirnamePath, join as joinPath } from "node:path";
import {
  deleteBridge,
  findBridgeByConversation,
  findBridgeByPendingTool,
  putBridge,
  type ParkedBridge,
  type ParkedToolCall,
} from "./bridge-pool.js";
import { withClaudeOAuthToken } from "./auth-env.js";
import { hasClaudeCliOAuthCredentials } from "./credentials.js";
import {
  accountConfigDir,
  AccountError,
  accountIcon,
  addAccount,
  applyAccountEnv,
  findAccount,
  getAccounts,
  getAccountsFilePath,
  getDefaultAccount,
  isMultiAccount,
  removeAccount,
  renameAccount,
  resolveAccount,
  setAccountIcon,
  setDefaultAccount,
  type ClaudeAccount,
} from "./accounts.js";
import {
  clearAccountCredentials,
  completeAccountLogin,
  findPendingLoginByState,
  confirmHeldLogin,
  discardHeldLogin,
  DuplicateLoginError,
  getHeldLogin,
  startAccountLogin,
} from "./account-login.js";
import { renderPanel } from "./panel.js";
import { refreshHostCatalog } from "./host-refresh.js";
import {
  accountsSharingLogin,
  clearAccountIdentity,
  renameAccountIdentity,
  fetchAccountIdentity,
  getAccountIdentity,
  labelLoginMismatch,
} from "./identity.js";
import {
  getAccountUsage,
  getAllAccountUsage,
  recordTurnUsage,
  renameAccountUsage,
} from "./usage-store.js";
import {
  accountsSharingSubscription,
  clearAccountQuota,
  formatQuotaSummary,
  getAccountQuota,
  getAllAccountQuota,
  mergeSdkRateLimitEvent,
  probeAccountQuota,
  renameAccountQuota,
} from "./quota.js";
import {
  classifyClaudeFailure,
  failureHintFor,
  failureStatusFor,
  failureTypeFor,
} from "./failure.js";
import {
  decodeClaudeModelSelection,
  EFFORT_HEADER,
} from "./model-selection.js";
import { parseAccountModelId, resolveClaudeModelId } from "./models.js";
import {
  ACCOUNT_HEADER,
  DIRECTORY_HEADER,
  LOOPBACK_CALLBACK_PATH,
  SESSION_HEADER,
  type ClaudeEffort,
} from "./constants.js";
import { startClaudeQuery, type ClaudeQueryHandle } from "./query.js";
import {
  bindConversationAccount,
  getSessionBinding,
  clearForeignSessionId,
  conversationKeyFromMessages,
  findClaudeSessionFile,
  getBoundAccountId,
  getForeignSessionId,
  listSessionBindings,
  renameBoundAccount,
  setForeignSessionId,
} from "./session-store.js";
import { log } from "./log.js";
import {
  getAllRateLimitSnapshots,
  getRateLimitSnapshot,
  maybeRateLimitNote,
  normalizeClaudeErrorText,
  rateLimitGate,
  recordRateLimitErrorText,
  recordRateLimitInfo,
  renameAccountRateLimit,
  formatResetCountdown,
} from "./rate-limit.js";
import {
  buildConversationTranscript,
  extractTextContent,
  latestUserPrompt,
  priorMessagesOf,
  promptAsStream,
  withConversationContext,
  type SdkUserPrompt,
} from "./prompt.js";
import {
  completeMetaRequest,
  heuristicTitle,
  metaChatCompletionResponse,
  sanitizeMetaOutput,
} from "./meta-completion.js";
import {
  buildMetaPrompt,
  detectMetaRequestKind,
  requestKeyNamespace,
} from "./request-kind.js";
import {
  formatCompactNote,
  usageFromSdkResult,
  type OpenAIUsage,
} from "./usage.js";

const SHARED_PROXY_HEALTH_TIMEOUT_MS = 750;

/**
 * Optional pinned port via OPENCODE_CLAUDE_PROXY_PORT.
 * Default is `0` — Bun binds an ephemeral free port; the live URL is then
 * published through the config hook + auth loader so OpenCode always hits the
 * process that owns the listener (no static 8787 requirement).
 */
const REQUESTED_PROXY_PORT: number = (() => {
  const raw = process.env.OPENCODE_CLAUDE_PROXY_PORT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed < 65536
    ? parsed
    : 0;
})();

/**
 * Interface the proxy binds to. Loopback by default — it holds subscription
 * tokens. Set OPENCODE_CLAUDE_PANEL_HOST=0.0.0.0 to put the panel behind a
 * reverse proxy you already trust; the panel is then only as protected as that
 * proxy makes it.
 */
const BIND_HOST = (() => {
  const raw = process.env.OPENCODE_CLAUDE_PANEL_HOST?.trim();
  return raw || "127.0.0.1";
})();

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

/**
 * Resolves the access token for ONE account. Multi-account setups call this
 * once per turn with the account the session is bound to.
 */
type TokenProvider = (account: ClaudeAccount) => Promise<string | null>;

type OpenAITool = {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

type OpenAIMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

type ChatCompletionRequest = {
  model?: string;
  messages?: OpenAIMessage[];
  tools?: OpenAITool[];
  stream?: boolean;
  temperature?: number;
};

let server: ReturnType<typeof Bun.serve> | null = null;
let proxyPort: number | null = null;
let getAccessToken: TokenProvider | null = null;

/** Injectable for smoke tests — production path always uses startClaudeQuery. */
let queryStarter: typeof startClaudeQuery = startClaudeQuery;

export function setClaudeQueryStarter(
  starter: typeof startClaudeQuery | null,
): void {
  queryStarter = starter ?? startClaudeQuery;
}

/**
 * Pre-flight credential probe (file reads only, no caching). Injectable for
 * smoke tests so they can simulate a host with no Claude credentials at all.
 */
let credentialProbe: (account: ClaudeAccount) => boolean = (account) =>
  hasClaudeCliOAuthCredentials(
    account.configDir ? { configDir: account.configDir } : undefined,
  );

export function setClaudeCredentialProbe(
  probe: ((account: ClaudeAccount) => boolean) | null,
): void {
  credentialProbe =
    probe ??
    ((account: ClaudeAccount) =>
      hasClaudeCliOAuthCredentials(
        account.configDir ? { configDir: account.configDir } : undefined,
      ));
}

export function getClaudeProxyBaseUrl(): string {
  const port = proxyPort ?? (REQUESTED_PROXY_PORT > 0 ? REQUESTED_PROXY_PORT : null);
  if (!port) {
    throw new Error(
      "Claude proxy is not listening yet — call startProxy() before getClaudeProxyBaseUrl()",
    );
  }
  return `http://127.0.0.1:${port}/v1`;
}

export function getProxyPort(): number | null {
  return proxyPort;
}

function isAddrInUseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  return (
    code === "EADDRINUSE" ||
    (typeof message === "string" &&
      /eaddrinuse|address already in use|in use/i.test(message))
  );
}

async function isProxyHealthyAt(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SHARED_PROXY_HEALTH_TIMEOUT_MS,
  );
  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => undefined)) as
      | { object?: unknown; data?: unknown }
      | undefined;
    return (
      !!body &&
      body.object === "list" &&
      Array.isArray(body.data)
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Write the live panel URL where a human can find it. The proxy binds an
 * ephemeral port by default, so without this the address only exists inside
 * a log line the host may not surface.
 */
function publishEndpoint(port: number): void {
  try {
    const xdg = process.env.XDG_DATA_HOME;
    const base = xdg ? xdg : joinPath(homedir(), ".local", "share");
    const path = joinPath(base, "opencode-claude", "endpoint.json");
    mkdirSync(dirnamePath(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        {
          port,
          panel: `http://127.0.0.1:${port}/`,
          baseURL: `http://127.0.0.1:${port}/v1`,
          pid: process.pid,
          updatedAt: Date.now(),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  } catch {
    // discoverability is a convenience — never fail startup over it
  }
}

export async function startProxy(tokenProvider: TokenProvider): Promise<number> {
  getAccessToken = tokenProvider;
  // Republish on every call, not just the first bind: the file is how a human
  // finds the panel, and it must survive a deleted file or a host that calls
  // startProxy again after the listener already exists.
  if (server && proxyPort) {
    publishEndpoint(proxyPort);
    return proxyPort;
  }

  // Only reuse a sibling listener when the operator pinned a port.
  if (REQUESTED_PROXY_PORT > 0) {
    const pinnedUrl = `http://127.0.0.1:${REQUESTED_PROXY_PORT}/v1`;
    if (await isProxyHealthyAt(pinnedUrl)) {
      proxyPort = REQUESTED_PROXY_PORT;
      publishEndpoint(proxyPort);
      log.info(`[opencode-claude] reusing healthy proxy on ${pinnedUrl}`);
      return proxyPort;
    }
  }

  const hostname = BIND_HOST;
  const bindPort = REQUESTED_PROXY_PORT; // 0 → ephemeral

  try {
    server = Bun.serve({
      hostname,
      port: bindPort,
      async fetch(req) {
        return handleRequest(req);
      },
    });
    proxyPort = server.port ?? null;
    if (!proxyPort) {
      throw new Error("Failed to bind Claude proxy to a port");
    }
    publishEndpoint(proxyPort);
    // warn, not info: the panel URL is the one thing an operator has to be able
    // to find, and info is debug-gated.
    log.warn(
      `[opencode-claude] proxy listening on ${getClaudeProxyBaseUrl()} · panel at http://127.0.0.1:${proxyPort}/`,
    );
    return proxyPort;
  } catch (err) {
    if (
      REQUESTED_PROXY_PORT > 0 &&
      isAddrInUseError(err) &&
      (await isProxyHealthyAt(`http://127.0.0.1:${REQUESTED_PROXY_PORT}/v1`))
    ) {
      proxyPort = REQUESTED_PROXY_PORT;
      publishEndpoint(proxyPort);
      log.info(
        `[opencode-claude] port ${REQUESTED_PROXY_PORT} in use; reusing existing proxy`,
      );
      return proxyPort;
    }
    throw err;
  }
}

export async function stopProxy(): Promise<void> {
  if (server) {
    server.stop(true);
    server = null;
    proxyPort = null;
  }
}

/**
 * The panel can add accounts and start OAuth, so mutating routes must not be
 * driven by some other site the operator happens to have open. The check is
 * same-origin: the browser's Origin must match the host this request arrived
 * on — whatever that host is.
 *
 * It used to test for loopback instead, which was fine while the panel was
 * loopback-only and became a self-inflicted 403 the moment it was served
 * through a reverse proxy: the page's own fetches carry the proxy's origin.
 * Loopback stays allowed on top, so a tunnelled browser still works.
 */
function isLocalOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // curl, xh, the plugin's own tooling
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = (forwardedHost || req.headers.get("host") || "").trim();
  try {
    const url = new URL(origin);
    if (host && url.host.toLowerCase() === host.toLowerCase()) return true;
    const hostname = url.hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

/** Minimal page the browser lands on after the OAuth redirect. */
function callbackPage(ok: boolean, message: string): Response {
  const colour = ok ? "#2f7d4f" : "#b3372c";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8">
<title>${ok ? "Connected" : "Not connected"}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; padding: 2rem; }
  .box { max-width: 34rem; text-align:center; }
  h1 { font-size: 1.1rem; margin: 0 0 .5rem; color: ${colour}; }
  p { margin: 0; opacity: .85; }
</style></head>
<body><div class="box"><h1>${ok ? "Connected" : "Not connected"}</h1>
<p>${message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</p>
</div></body></html>`,
    {
      status: ok ? 200 : 400,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

/**
 * Carry every per-account store to a new id. Missed one and the account keeps
 * its name but loses its quota, usage, identity and session bindings.
 */
export function migrateAccountStores(
  oldId: string,
  newId: string,
  newLabel: string,
): void {
  renameAccountQuota(oldId, newId);
  renameAccountIdentity(oldId, newId);
  renameAccountUsage(oldId, newId);
  renameAccountRateLimit(oldId, newId);
  renameBoundAccount(oldId, newId, newLabel);
}

function jsonError(message: string, status: number): Response {
  return Response.json(
    { error: { message, type: status === 404 ? "not_found" : "invalid_request_error" } },
    { status },
  );
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Account payload for the panel: identity, auth state, limits and usage. */
function describeAccount(
  account: ClaudeAccount,
  sessionCounts: Map<string, number>,
): Record<string, unknown> {
  return {
    id: account.id,
    label: account.label,
    icon: accountIcon(account),
    iconPinned: Boolean(account.icon),
    default: account.isDefault,
    configDir: accountConfigDir(account),
    authenticated: credentialProbe(account),
    sessions: sessionCounts.get(account.id) ?? 0,
    rateLimit: getRateLimitSnapshot(Date.now(), account.id),
    usage: getAccountUsage(account.id),
    quota: getAccountQuota(account.id),
    // Who this actually is. A consent screen approved by an existing claude.ai
    // session re-authorizes the SAME login without ever offering a picker, so
    // the email is the only honest answer to "is this a second subscription".
    identity: getAccountIdentity(account.id),
    // The label names a login that is not the one behind the credential. Older
    // labels predate the write-time rule, and a label written when the cached
    // identity said somebody else was never refused in the first place.
    labelClaimsLogin: labelLoginMismatch(account.id, account.label),
    sharesLoginWith: accountsSharingLogin(account.id),
    // A login exchanged but deliberately not written, awaiting a decision.
    heldDuplicateLogin: Boolean(getHeldLogin(account.id)),
    // Same organization but a different login (two seats on one Team) is not
    // the same thing as the same login twice — kept separate on purpose.
    sharesOrganizationWith: accountsSharingSubscription(account.id),
  };
}

function sessionCountsByAccount(): Map<string, number> {
  const defaultId = getDefaultAccount().id;
  const counts = new Map<string, number>();
  for (const binding of listSessionBindings()) {
    const id = binding.accountId ?? defaultId;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Panel routes. Returns null when the path is not one of them, so the main
 * handler can fall through to the OpenAI-compatible surface.
 */
async function handlePanelRoutes(
  req: Request,
  url: URL,
): Promise<Response | null> {
  const path = url.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";

  if (req.method === "GET" && (path === "/" || path === "/panel" || path === "/ui")) {
    // Traefik's StripPrefix tells us where the page really lives, so relative
    // fetches resolve under /claude/ as readily as under /.
    const prefix = req.headers.get("x-forwarded-prefix")?.trim() ?? "";
    const basePath = `${prefix.replace(/\/+$/, "")}/`;
    return new Response(renderPanel(basePath), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // The page is entirely inline; nothing may be fetched from anywhere.
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'",
      },
    });
  }

  // Loopback OAuth callback. The browser lands here after approving; the
  // account is recovered from `state`, since one shared listener serves every
  // account and the path carries no id.
  if (req.method === "GET" && path === LOOPBACK_CALLBACK_PATH) {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      return callbackPage(
        false,
        `Claude returned "${oauthError}". Nothing was saved.`,
      );
    }
    if (!code || !state) {
      return callbackPage(false, "The callback carried no code — nothing was saved.");
    }
    const loginEntry = findPendingLoginByState(state);
    if (!loginEntry) {
      return callbackPage(
        false,
        "No login is waiting for this callback (they expire after 15 minutes). Start again from the panel.",
      );
    }
    const account = findAccount(loginEntry.accountId);
    if (!account) {
      return callbackPage(false, `Account "${loginEntry.accountId}" no longer exists.`);
    }
    try {
      const result = await completeAccountLogin(account, `${code}#${state}`);
      return callbackPage(
        true,
        `Connected ${account.label}${
          result.identity?.email ? ` as ${result.identity.email}` : ""
        }. You can close this tab.`,
      );
    } catch (err) {
      if (err instanceof DuplicateLoginError) {
        // Held, not written. The panel shows the decision.
        return callbackPage(
          false,
          `${err.message} Nothing was saved — return to the panel to connect it anyway or discard it.`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error("[opencode-claude] loopback callback failed", message);
      return callbackPage(false, message);
    }
  }

  if (req.method === "GET" && path === "/accounts") {
    // The LAN route deliberately bypasses Keycloak for GETs only. A one-shot
    // refresh requested by the panel therefore has to happen inside this GET;
    // all account-management mutations remain POST/DELETE and stay protected.
    // Normal 15s panel polling omits the flag, so it never spends quota.
    if (url.searchParams.get("refresh") === "stale") {
      const now = Date.now();
      const stale = getAccounts().filter((account) => {
        if (!credentialProbe(account)) return false;
        const fetchedAt = getAccountQuota(account.id)?.fetchedAt ?? 0;
        return now - fetchedAt > 10 * 60_000;
      });
      await Promise.allSettled(
        stale.map(async (account) => {
          await probeAccountQuota(account);
          await fetchAccountIdentity(account).catch(() => null);
        }),
      );
    }
    const counts = sessionCountsByAccount();
    return Response.json({
      object: "list",
      multiAccount: isMultiAccount(),
      registryPath: getAccountsFilePath(),
      data: getAccounts().map((account) => describeAccount(account, counts)),
    });
  }

  if (req.method === "GET" && path === "/usage") {
    return Response.json({
      object: "usage",
      accounts: getAllAccountUsage(),
    });
  }

  // Last known quota per account. Read-only and free: refreshing costs a real
  // (tiny) request, so it is a separate explicit POST.
  if (req.method === "GET" && path === "/quota") {
    return Response.json({
      object: "quota",
      accounts: getAllAccountQuota(),
    });
  }

  if (req.method === "GET" && path === "/sessions") {
    const defaultId = getDefaultAccount().id;
    const wanted = url.searchParams.get("account")?.trim().toLowerCase();
    const data = listSessionBindings()
      .map((binding) => {
        const accountId = binding.accountId ?? defaultId;
        return {
          conversationKey: binding.conversationKey,
          account: accountId,
          // Current label, not the one captured at bind time — a rename must
          // not leave old names scattered across the session list.
          accountLabel: resolveAccount(accountId).label,
          modelId: binding.modelId,
          cwd: binding.cwd,
          claudeSessionId: binding.foreignSessionId || null,
          updatedAt: binding.updatedAt,
        };
      })
      .filter((entry) => !wanted || entry.account === wanted);
    return Response.json({ object: "list", data });
  }

  // ---- mutations ----
  const accountMatch = /^\/accounts\/([^/]+)(?:\/(login\/start|login\/complete|login\/confirm|login\/discard|disconnect|default|rename|icon|quota\/refresh))?$/
    .exec(path);
  const sessionMatch = /^\/sessions\/([^/]+)\/account$/.exec(path);
  const isMutation =
    req.method !== "GET" &&
    (path === "/accounts" || accountMatch !== null || sessionMatch !== null);

  if (isMutation && !isLocalOrigin(req)) {
    return jsonError("cross-origin requests are not accepted by the panel", 403);
  }

  try {
    if (req.method === "POST" && path === "/accounts") {
      const body = await readJsonBody(req);
      const account = addAccount({
        id: body.id,
        label: body.label,
        configDir: body.configDir,
        makeDefault: body.makeDefault === true,
      });
      await refreshHostCatalog();
      return Response.json(
        describeAccount(account, sessionCountsByAccount()),
        { status: 201 },
      );
    }

    if (accountMatch) {
      const id = decodeURIComponent(accountMatch[1]);
      const action = accountMatch[2];
      const account = findAccount(id);
      if (!account) return jsonError(`unknown account "${id}"`, 404);

      if (req.method === "DELETE" && !action) {
        removeAccount(id);
        clearAccountIdentity(id);
        clearAccountQuota(id);
        await refreshHostCatalog();
        return Response.json({ removed: id });
      }
      if (req.method === "POST" && action === "default") {
        const chosen = setDefaultAccount(id).id;
        await refreshHostCatalog();
        return Response.json({ default: chosen });
      }
      if (req.method === "POST" && action === "rename") {
        const body = await readJsonBody(req);
        const renamed = renameAccount(id, body.label, {
          newId: body.newId,
          migrate: migrateAccountStores,
        });
        await refreshHostCatalog();
        return Response.json({ account: renamed.id, label: renamed.label });
      }
      if (req.method === "POST" && action === "icon") {
        const body = await readJsonBody(req);
        const updated = setAccountIcon(id, body.icon ?? "");
        await refreshHostCatalog();
        return Response.json({ account: updated.id, icon: accountIcon(updated) });
      }
      if (req.method === "POST" && action === "disconnect") {
        clearAccountCredentials(account);
        clearAccountIdentity(id);
        // Stale quota belongs to the login that just left; showing it on a
        // disconnected card invents capacity that is not addressable.
        clearAccountQuota(id);
        return Response.json({ disconnected: id });
      }
      if (req.method === "POST" && action === "quota/refresh") {
        // Costs one minimal Messages call against the window it measures —
        // operator-initiated only, never on a timer.
        const quota = await probeAccountQuota(account);
        // The profile call is free, so refresh identity while we are here.
        await fetchAccountIdentity(account).catch(() => null);
        return Response.json(quota);
      }
      if (req.method === "POST" && action === "login/start") {
        // Close the loop automatically when we know our own address: the
        // Claude Code client registers only loopback redirects, and the
        // redirect is performed by the operator's browser, so it must be able
        // to reach this listener (same machine, or an SSH tunnel).
        // Only offer the automatic loopback callback when the browser that
        // will follow the redirect can actually reach loopback — i.e. it came
        // in on 127.0.0.1. Through a reverse proxy the redirect would land on
        // the operator's OWN machine, so those logins use the paste flow.
        const port = getProxyPort();
        const viaLoopback = /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(
          req.headers.get("host") ?? "",
        );
        const pending = await startAccountLogin(
          account,
          port && viaLoopback
            ? { redirectUri: `http://127.0.0.1:${port}${LOOPBACK_CALLBACK_PATH}` }
            : undefined,
        );
        return Response.json({
          account: id,
          url: pending.url,
          manual: pending.manual,
          redirectUri: pending.redirectUri,
        });
      }
      if (req.method === "POST" && action === "login/complete") {
        const body = await readJsonBody(req);
        const code = typeof body.code === "string" ? body.code : "";
        if (!code.trim()) return jsonError("code is required", 400);
        try {
          const result = await completeAccountLogin(account, code);
          return Response.json({
            account: id,
            connected: true,
            expiresAt: result.expiresAt,
            identity: result.identity,
          });
        } catch (err) {
          // Nothing was written: the tokens are held so the operator can still
          // say "yes, I meant it" without another browser round trip.
          if (err instanceof DuplicateLoginError) {
            return Response.json(
              {
                error: {
                  message: err.message,
                  type: "invalid_request_error",
                  code: err.code,
                },
                duplicateOf: err.duplicateOf,
                email: err.email,
                canConfirm: true,
              },
              { status: err.status },
            );
          }
          throw err;
        }
      }

      // Commit a login that was held back as a duplicate.
      if (req.method === "POST" && action === "login/confirm") {
        const result = confirmHeldLogin(account);
        return Response.json({
          account: id,
          connected: true,
          expiresAt: result.expiresAt,
          identity: result.identity,
          duplicateOf: accountsSharingLogin(id),
        });
      }

      if (req.method === "POST" && action === "login/discard") {
        discardHeldLogin(id);
        return Response.json({ discarded: id });
      }
    }

    if (sessionMatch && req.method === "POST") {
      const conversationKey = decodeURIComponent(sessionMatch[1]);
      const body = await readJsonBody(req);
      const target = findAccount(
        typeof body.account === "string" ? body.account : "",
      );
      if (!target) return jsonError("unknown account", 404);
      if (!getSessionBinding(conversationKey)) {
        return jsonError(`unknown session "${conversationKey}"`, 404);
      }
      // Same rule as an in-band switch: the resume target belongs to the old
      // account's Claude home and must not follow the session across.
      bindConversationAccount(conversationKey, target.id, target.label);
      return Response.json({ conversationKey, account: target.id });
    }
  } catch (err) {
    if (err instanceof AccountError) return jsonError(err.message, err.status);
    const message = err instanceof Error ? err.message : String(err);
    log.warn("[opencode-claude] panel request failed", { path, message });
    return jsonError(message, 400);
  }

  return null;
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  const panelResponse = await handlePanelRoutes(req, url);
  if (panelResponse) return panelResponse;

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
    const account = resolveAccount(url.searchParams.get("account"));
    const rateLimit = getRateLimitSnapshot(Date.now(), account.id);
    return Response.json({
      ok: true,
      provider: "claude-code",
      account: account.id,
      accountLabel: account.label,
      accounts: getAccounts().map((a) => a.id),
      quota: formatQuotaSummary(getAccountQuota(account.id)),
      rateLimit: {
        limited: rateLimit.limited,
        ...(rateLimit.resetsAtISO ? { resetsAt: rateLimit.resetsAtISO } : {}),
        ...(rateLimit.resetInSeconds !== undefined
          ? { resetInSeconds: rateLimit.resetInSeconds }
          : {}),
        ...(rateLimit.utilization !== undefined
          ? { utilization: rateLimit.utilization }
          : {}),
      },
    });
  }

  // Live "when are limits back" counter for OpenChamber / OpenCode UIs.
  // `?account=<id>` scopes it; without it, the default account's counter plus
  // a per-account map so a UI can show every subscription at once.
  if (
    req.method === "GET" &&
    (url.pathname === "/rate-limit" || url.pathname === "/v1/rate-limit")
  ) {
    const requested = url.searchParams.get("account");
    const account = resolveAccount(requested);
    const snapshot = getRateLimitSnapshot(Date.now(), account.id);
    if (requested || !isMultiAccount()) {
      return Response.json({ account: account.id, ...snapshot });
    }
    return Response.json({
      account: account.id,
      ...snapshot,
      accounts: getAllRateLimitSnapshots(),
    });
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    const { getClaudeModels } = await import("./models.js");
    return Response.json({
      object: "list",
      data: getClaudeModels().map((m) => ({
        id: m.id,
        object: "model",
        owned_by: "claude-code",
      })),
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    try {
      const body = (await req.json()) as ChatCompletionRequest;
      return await handleChatCompletions(req, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("[opencode-claude] chat completions error", message);
      return Response.json(
        { error: { message, type: "server_error" } },
        { status: 500 },
      );
    }
  }

  return new Response("Not Found", { status: 404 });
}

function collectToolResults(
  messages: OpenAIMessage[],
): Map<string, string> {
  const results = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "tool" || !msg.tool_call_id) continue;
    results.set(msg.tool_call_id, extractTextContent(msg.content));
  }
  return results;
}

function selectionFromRequest(
  req: Request,
  body: ChatCompletionRequest,
): { modelId: string; effort?: ClaudeEffort; account?: string } {
  const header = req.headers.get(EFFORT_HEADER);
  const decoded = decodeClaudeModelSelection(header);
  const rawModel =
    decoded?.modelId ||
    (typeof body.model === "string" ? body.model.replace(/^claude-code\//, "") : "sonnet");
  // The account can arrive three ways: the encoded selection (OpenCode host),
  // an explicit header (direct callers), or baked into the model id itself
  // (`opus@work`) when the request bypassed the chat.headers hook.
  const { baseModelId, accountId } = parseAccountModelId(rawModel);
  const account =
    decoded?.account ||
    req.headers.get(ACCOUNT_HEADER)?.trim() ||
    accountId ||
    undefined;
  const effort = decoded?.effort;
  return {
    modelId: baseModelId || rawModel,
    ...(effort ? { effort } : {}),
    ...(account ? { account } : {}),
  };
}

/**
 * Which subscription runs this turn.
 *
 * Explicit beats sticky: picking `opus@work` moves the session to `work`.
 * Otherwise the session stays on whatever it was bound to, so a conversation
 * never silently hops subscriptions mid-way (which would also strand its
 * Claude transcript in another account's home).
 */
function resolveTurnAccount(
  conversationKey: string,
  requested?: string,
): { account: ClaudeAccount; switched: boolean } {
  const bound = getBoundAccountId(conversationKey);
  if (requested) {
    const account = resolveAccount(requested);
    return { account, switched: Boolean(bound) && bound !== account.id };
  }
  if (bound) return { account: resolveAccount(bound), switched: false };
  return { account: getDefaultAccount(), switched: false };
}

/** Env flag to turn the `[account]` title prefix off. */
function titleTagDisabled(): boolean {
  const flag = (process.env.OPENCODE_CLAUDE_ACCOUNT_TITLE_TAG ?? "").toLowerCase();
  return flag === "0" || flag === "false" || flag === "off";
}

/**
 * Prefix a generated session title with its account: "[work] Fix the proxy".
 * No-op for single-account setups, and idempotent so a re-titled session does
 * not accumulate tags.
 */
export function withAccountTitleTag(
  title: string,
  account: ClaudeAccount,
): string {
  if (!isMultiAccount() || titleTagDisabled()) return title;
  const clean = title.trim();
  const identity = getAccountIdentity(account.id);
  const sharedLogin = accountsSharingLogin(account.id).length > 0;
  const tag = sharedLogin && identity?.email
    ? `[${account.id}=${identity.email}]`
    : `[${account.id}]`;
  if (clean.toLowerCase().startsWith(`${tag.toLowerCase()} `)) return clean;
  // Strip a tag from another account before applying this one (session moved).
  const foreign = /^\[([a-z0-9._-]{1,32})(?:=[^\]\s]+)?\]\s+/i.exec(clean);
  const bare =
    foreign && getAccounts().some((a) => a.id === foreign[1].toLowerCase())
      ? clean.slice(foreign[0].length)
      : clean;
  return `${tag} ${bare}`;
}

async function handleChatCompletions(
  req: Request,
  body: ChatCompletionRequest,
): Promise<Response> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const metaKind = detectMetaRequestKind(messages);
  const sessionHeader = req.headers.get(SESSION_HEADER);
  /** Identity of the chat itself, shared by the turn and its meta requests. */
  const sessionKey = sessionHeader || conversationKeyFromMessages(messages);
  const conversationKey = requestKeyNamespace(metaKind) + sessionKey;
  const selection = selectionFromRequest(req, body);
  const model = resolveClaudeModelId(selection.modelId);
  const stream = body.stream !== false;

  // Bind this conversation to a Claude subscription before anything else: the
  // account decides which credentials, which transcripts and which rate-limit
  // window the rest of this turn touches.
  // Keyed on the chat, not on the namespaced request key, so a title/summary
  // request bills the same subscription as the turn that triggered it.
  const { account, switched } = resolveTurnAccount(sessionKey, selection.account);
  if (switched) {
    log.info("[opencode-claude] session moved to another Claude account", {
      conversationKey: sessionKey,
      account: account.id,
    });
  }
  if (!metaKind && isMultiAccount()) {
    bindConversationAccount(sessionKey, account.id, account.label);
  }
  const accountConfig = account.configDir ? accountConfigDir(account) : undefined;

  // Resume a parked bridge if OpenCode returned tool results.
  const toolResults = collectToolResults(messages);
  let existing = findBridgeByConversation(conversationKey);
  // Fallback: match by tool_call_id when the session header is missing/changed.
  if ((!existing || existing.pendingTools.size === 0) && toolResults.size > 0) {
    for (const toolCallId of toolResults.keys()) {
      const byTool = findBridgeByPendingTool(toolCallId);
      if (byTool) {
        existing = byTool;
        break;
      }
    }
  }
  if (existing && existing.pendingTools.size > 0) {
    let resolved = 0;
    for (const [toolId, tool] of existing.pendingTools) {
      const result = toolResults.get(toolId);
      if (result !== undefined) {
        tool.resolve(result);
        existing.pendingTools.delete(toolId);
        resolved++;
      }
    }
    if (existing.pendingTools.size === 0 && existing.continueStream) {
      log.info("[opencode-claude] resuming parked bridge", {
        conversationKey: existing.conversationKey,
        resolved,
      });
      return stream
        ? streamOpenAIResponse(
            existing.continueStream(),
            body.model || model,
            existing,
          )
        : collectTurnResponse(
            existing.continueStream(),
            body.model || model,
            existing,
          );
    }
    // Still parked — do not start a parallel Claude turn (OpenCode may retry
    // or send a follow-up before tool results arrive). Re-emit pending calls.
    // Also covers partial tool results (resolved > 0 but others still pending).
    if (existing.pendingTools.size > 0) {
      log.info("[opencode-claude] re-emitting parked tool_calls", {
        conversationKey: existing.conversationKey,
        pending: existing.pendingTools.size,
        resolved,
      });
      const parkedEvents = (async function* () {
        yield { type: "__park__", tools: [...existing!.pendingTools.values()] };
      })();
      return stream
        ? streamOpenAIResponse(parkedEvents, body.model || model, existing)
        : collectTurnResponse(parkedEvents, body.model || model, existing);
    }
  }

  log.info("[opencode-claude] chat completions", {
    conversationKey,
    sessionHeader,
    account: account.id,
    metaKind,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    messageCount: messages.length,
    hasToolResults: toolResults.size > 0,
    bridgePending: existing?.pendingTools.size ?? 0,
  });

  const accessToken = getAccessToken ? await getAccessToken(account) : null;

  // Title / summary: fast Anthropic Messages API path (not Agent SDK).
  // OpenCode fires these in parallel with the main turn and disposes the
  // session ~2–3s later — Agent SDK is too slow, so titles stayed "New session".
  if (metaKind) {
    const meta = buildMetaPrompt(messages);
    if (!meta.prompt.trim() || meta.prompt === " ") {
      return Response.json(
        {
          error: {
            message: "No user message found",
            type: "invalid_request_error",
          },
        },
        { status: 400 },
      );
    }
    const completionId = `chatcmpl_${createHash("sha1")
      .update(`${conversationKey}:${metaKind}:${Date.now()}`)
      .digest("hex")
      .slice(0, 24)}`;
    const started = Date.now();
    log.info("[opencode-claude] meta request (fast path)", {
      kind: metaKind,
      systemChars: meta.system.length,
      promptChars: meta.prompt.length,
    });

    let content: string;
    let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
    let responseModel = body.model || "claude-haiku-4-5";

    if (!accessToken) {
      content =
        metaKind === "title"
          ? heuristicTitle(meta.prompt)
          : sanitizeMetaOutput("", metaKind, meta.prompt);
      log.warn("[opencode-claude] meta request without OAuth; using heuristic", {
        kind: metaKind,
        content,
      });
    } else {
      try {
        const result = await completeMetaRequest({
          body: { messages },
          kind: metaKind,
          accessToken,
          model: "claude-haiku-4-5",
          accountId: account.id,
        });
        content = result.text;
        usage = result.usage;
        responseModel = body.model || result.model;
        log.info("[opencode-claude] meta request complete", {
          kind: metaKind,
          ms: Date.now() - started,
          chars: content.length,
          content: metaKind === "title" ? content : undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        content =
          metaKind === "title"
            ? heuristicTitle(meta.prompt)
            : `Summary unavailable: ${message}`;
        log.warn("[opencode-claude] meta fast path failed; falling back", {
          kind: metaKind,
          message,
          content: metaKind === "title" ? content : undefined,
        });
      }
    }

    // Tag generated titles with the account. OpenChamber renders the title in
    // the session list, so this is what makes "this session runs on work, that
    // one on personal" readable without opening anything. Only in
    // multi-account mode, and only for titles — summaries stay clean.
    if (metaKind === "title") {
      const boundAccountId = getBoundAccountId(sessionKey);
      if (boundAccountId) {
        content = withAccountTitleTag(content, resolveAccount(boundAccountId));
      }
    }

    return metaChatCompletionResponse({
      stream,
      id: completionId,
      model: responseModel,
      content,
      usage,
    });
  }

  // Pre-flight: without any credentials at all, a spawned turn is guaranteed
  // to die with a 401 AFTER burning time (and previously surfaced as a
  // fake-200 error text that hosts retried in a loop). Fail fast with a real
  // 401 — nothing is sent to Anthropic. When CLI credentials exist we still
  // proceed WITHOUT injecting an env token so the CLI can auto-refresh its
  // own credentials file.
  if (!accessToken && !credentialProbe(account)) {
    log.warn("[opencode-claude] no Claude credentials; failing fast", {
      conversationKey,
      account: account.id,
    });
    return Response.json(
      {
        error: {
          message: isMultiAccount()
            ? `Claude account "${account.label}" is not authenticated. Run \`CLAUDE_CONFIG_DIR=${accountConfigDir(
                account,
              )} claude auth login\` — no request was sent to Anthropic.`
            : "Claude Code is not authenticated. Sign in via the plugin OAuth flow or `claude auth login` — no request was sent to Anthropic.",
          type: "authentication_error",
          code: "claude_auth_required",
        },
      },
      { status: 401, headers: { [ACCOUNT_HEADER]: account.id } },
    );
  }

  const env = accessToken
    ? withClaudeOAuthToken(accessToken)
    : withClaudeOAuthToken("", process.env);

  if (!accessToken) {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  // Point the spawned CLI at this account's Claude home. Its own credentials
  // file lives there, so the CLI keeps ownership of its refresh chain — the
  // one thing that must never be shared between accounts.
  const childEnv = applyAccountEnv(account, env);

  const openCodeTools = Array.isArray(body.tools) ? body.tools : [];
  const requestDirectory = req.headers.get(DIRECTORY_HEADER)?.trim();
  const cwd =
    process.env.OPENCODE_CLAUDE_CWD || requestDirectory || process.cwd();
  const bridgeId = randomUUID();
  const pendingTools = new Map<string, ParkedToolCall>();
  let handle: ClaudeQueryHandle | null = null;
  let parked = false;
  let parkWaiters: Array<() => void> = [];

  const notifyPark = () => {
    parked = true;
    const waiters = parkWaiters;
    parkWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const prompt = latestUserPrompt(messages);
  if (typeof prompt !== "string") {
    const parts = Array.isArray(prompt.message.content)
      ? prompt.message.content.map((b) => b.type)
      : ["text"];
    log.info("[opencode-claude] multimodal user prompt", {
      blockTypes: parts,
    });
  } else {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const content = lastUser?.content;
    if (Array.isArray(content)) {
      log.info("[opencode-claude] user content parts", {
        partTypes: content.map((p) =>
          p && typeof p === "object" && "type" in p
            ? (p as { type?: unknown }).type
            : typeof p,
        ),
      });
    }
  }
  const promptEmpty =
    typeof prompt === "string" ? prompt.length === 0 : false;
  if (promptEmpty && openCodeTools.length === 0) {
    return Response.json(
      { error: { message: "No user message found", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  // Confirmed hard subscription limit active? Fail fast with a proper 429 +
  // Retry-After instead of spawning a doomed Agent SDK turn (which would
  // surface as a fake "completed" assistant message and burn time).
  // Placed after input validation so malformed requests still get 400.
  // Scoped to this account: limits are per subscription, so an exhausted
  // account must not gate turns running on a different one.
  const gate = rateLimitGate(Date.now(), account.id);
  if (gate.blocked) {
    log.warn("[opencode-claude] rate-limit gate blocked a turn", {
      conversationKey,
      account: account.id,
      retryAfterSeconds: gate.retryAfterSeconds,
    });
    const gateSummary = formatQuotaSummary(getAccountQuota(account.id));
    return Response.json(
      {
        error: {
          message: gateSummary ? `${gate.message} · ${gateSummary}` : gate.message,
          type: "rate_limit_error",
          code: "claude_session_limit",
          ...(gate.resetsAt !== undefined
            ? { resets_at: new Date(gate.resetsAt).toISOString() }
            : {}),
          retry_after: gate.retryAfterSeconds,
        },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(gate.retryAfterSeconds),
          [ACCOUNT_HEADER]: account.id,
          ...(gate.resetsAt !== undefined
            ? { "x-claude-rate-limit-reset": new Date(gate.resetsAt).toISOString() }
            : {}),
        },
      },
    );
  }

  let resume = getForeignSessionId(conversationKey);
  if (resume && !findClaudeSessionFile(resume, accountConfig)) {
    // The claude CLI resumes by looking the session up on disk. A missing
    // transcript (cleanup, different machine, pruned projects dir) would
    // silently start a context-free session — drop the stale binding and
    // transfer the conversation history into the prompt instead.
    log.warn("[opencode-claude] stored Claude session file missing; transferring history", {
      conversationKey,
      foreignSessionId: resume,
    });
    clearForeignSessionId(conversationKey);
    resume = undefined;
  }

  // No resumable Claude session (first claude-code turn of this chat, model
  // switch mid-conversation, lost store): serialize the prior OpenCode
  // messages into the prompt so Claude sees the whole conversation.
  const transcript = resume
    ? ""
    : buildConversationTranscript(priorMessagesOf(messages));
  if (transcript) {
    log.info("[opencode-claude] injecting transferred conversation history", {
      conversationKey,
      transcriptChars: transcript.length,
      historyMessages: priorMessagesOf(messages).length,
    });
  }
  const contextualPrompt = withConversationContext(prompt, transcript);

  const mcpServers =
    openCodeTools.length > 0
      ? await buildOpenCodeMcpServer(openCodeTools, pendingTools, notifyPark)
      : undefined;

  const bridgeOpenCodeTools = openCodeTools.length > 0;
  const openCodeToolNames = openCodeTools
    .map((t) => t.function?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  const toolAliases = bridgeOpenCodeTools
    ? Object.fromEntries(
        openCodeToolNames.flatMap((name) => {
          const mcpName = `mcp__opencode__${name}`;
          const aliases: Array<[string, string]> = [[name, mcpName]];
          const titled = name.charAt(0).toUpperCase() + name.slice(1);
          if (titled !== name) aliases.push([titled, mcpName]);
          if (name === "bash") aliases.push(["Bash", mcpName]);
          if (name === "read") aliases.push(["Read", mcpName]);
          if (name === "edit") aliases.push(["Edit", mcpName]);
          if (name === "write") aliases.push(["Write", mcpName]);
          if (name === "glob") aliases.push(["Glob", mcpName]);
          if (name === "grep") aliases.push(["Grep", mcpName]);
          // Claude Code's built-in todo habit must land on OpenCode's todo
          // tools or plans die with the turn (never persisted/transferred).
          if (name === "todowrite") aliases.push(["TodoWrite", mcpName]);
          if (name === "todoread") aliases.push(["TodoRead", mcpName]);
          return aliases;
        }),
      )
    : undefined;

  const queryPrompt: string | AsyncIterable<SdkUserPrompt> =
    typeof contextualPrompt === "string"
      ? contextualPrompt || " "
      : promptAsStream(contextualPrompt);

  const hasTodoWrite = openCodeToolNames.includes("todowrite");
  handle = await queryStarter({
    prompt: queryPrompt,
    cwd,
    model,
    resume,
    effort: selection.effort,
    env: childEnv,
    mcpServers,
    autoCompactEnabled: true,
    tools: bridgeOpenCodeTools ? [] : undefined,
    toolAliases,
    allowedTools: bridgeOpenCodeTools
      ? openCodeToolNames.map((n) => `mcp__opencode__${n}`)
      : undefined,
    permissionMode: bridgeOpenCodeTools
      ? "bypassPermissions"
      : "acceptEdits",
    allowDangerouslySkipPermissions: bridgeOpenCodeTools,
    ...(bridgeOpenCodeTools
      ? {}
      : {
          canUseTool: async (
            _toolName: string,
            input: Record<string, unknown>,
          ) => ({ behavior: "allow" as const, updatedInput: input }),
        }),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(bridgeOpenCodeTools
        ? {
            append: [
              "You are running inside OpenCode. Built-in Claude Code tools are disabled. Use only the mcp__opencode__* tools provided for this turn; they execute via OpenCode.",
              "Batch independent tool calls into a single turn instead of calling them one at a time.",
              ...(hasTodoWrite
                ? [
                    "For any multi-step work, ALWAYS write the plan with the mcp__opencode__todowrite tool and keep it updated as you progress. A plan that only exists in your text is lost when the session is restored or handed to another agent.",
                  ]
                : []),
            ].join(" "),
          }
        : {}),
    },
  });

  const bridge: ParkedBridge = {
    id: bridgeId,
    conversationKey,
    accountId: account.id,
    handle,
    pendingTools,
    createdAt: Date.now(),
  };
  putBridge(bridge);

  async function* consumeStream(): AsyncGenerator<unknown, void, unknown> {
    const iterator = handle!.stream[Symbol.asyncIterator]();
    try {
      while (true) {
        const parkControl = {
          cancel: null as (() => void) | null,
        };
        const parkPromise = new Promise<void>((resolve) => {
          if (parked && pendingTools.size > 0) {
            resolve();
            return;
          }
          const entry = () => resolve();
          parkWaiters.push(entry);
          parkControl.cancel = () => {
            parkWaiters = parkWaiters.filter((w) => w !== entry);
          };
        });

        const nextPromise = iterator.next();
        const raced = await Promise.race([
          nextPromise.then((value) => ({ kind: "event" as const, value })),
          parkPromise.then(() => ({ kind: "park" as const })),
        ]);

        if (raced.kind === "park" || (parked && pendingTools.size > 0)) {
          parkControl.cancel?.();
          await Promise.resolve();
          yield { type: "__park__", tools: [...pendingTools.values()] };
          return;
        }

        parkControl.cancel?.();
        if (raced.value.done) break;
        const event = raced.value.value;
        const sessionId = extractSessionId(event);
        if (sessionId) {
          setForeignSessionId(conversationKey, sessionId, {
            modelId: model,
            cwd,
            // Only stamp the account when there is a choice to record. Doing it
            // unconditionally would keep a stub entry alive for every
            // single-account conversation, and stubs resurface as `resume: ""`.
            ...(isMultiAccount()
              ? { accountId: account.id, accountLabel: account.label }
              : {}),
          });
        }
        yield event;
      }
    } finally {
      if (!parked) {
        handle?.close();
        deleteBridge(bridgeId);
      }
    }
  }

  bridge.continueStream = async function* () {
    parked = false;
    parkWaiters = [];
    yield* consumeStream();
  };

  // A turn that dies BEFORE producing any content (bad token, session limit,
  // spawn failure) must surface as a truthful HTTP error — never as a
  // fake-200 stream whose only "assistant text" is the error. Hosts retry
  // fake-200 turns in a loop and each retry re-sends the whole conversation
  // to Anthropic: that doom loop burned ~4% of a weekly quota on 2026-08-11.
  if (stream) {
    const probe = await probeTurnEvents(consumeStream());
    if (probe.status === "failed") {
      return failureResponse(probe.errorText, conversationKey, account.id);
    }
    return streamOpenAIResponse(probe.replay, body.model || model, bridge);
  }
  return collectTurnResponse(consumeStream(), body.model || model, bridge);
}


function extractSessionId(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (typeof e.session_id === "string" && e.session_id) return e.session_id;
  if (e.type === "system" && e.subtype === "init") {
    const sid = (e as { session_id?: string }).session_id;
    if (typeof sid === "string") return sid;
  }
  return null;
}

async function buildOpenCodeMcpServer(
  tools: OpenAITool[],
  pendingTools: Map<string, ParkedToolCall>,
  onPark: () => void,
): Promise<Record<string, unknown> | undefined> {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const { z } = await import("zod");
    const createSdkMcpServer = (sdk as { createSdkMcpServer?: Function })
      .createSdkMcpServer;
    const toolFactory = (sdk as { tool?: Function }).tool;
    if (typeof createSdkMcpServer !== "function" || typeof toolFactory !== "function") {
      log.warn("[opencode-claude] SDK MCP helpers unavailable; OpenCode tools disabled");
      return undefined;
    }

    const jsonSchemaToZodShape = (
      schema: Record<string, unknown> | undefined,
    ): Record<string, unknown> => {
      const props =
        schema &&
        typeof schema === "object" &&
        schema.properties &&
        typeof schema.properties === "object"
          ? (schema.properties as Record<string, unknown>)
          : {};
      const required = new Set(
        Array.isArray(schema?.required)
          ? schema!.required.filter((x): x is string => typeof x === "string")
          : [],
      );
      const shape: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(props)) {
        const type =
          prop && typeof prop === "object"
            ? (prop as { type?: unknown }).type
            : undefined;
        let field: unknown = z.any();
        if (type === "string") field = z.string();
        else if (type === "number" || type === "integer") field = z.number();
        else if (type === "boolean") field = z.boolean();
        else if (type === "array") field = z.array(z.any());
        else if (type === "object") field = z.record(z.string(), z.any());
        if (!required.has(key)) {
          field = (field as { optional: () => unknown }).optional();
        }
        shape[key] = field;
      }
      return shape;
    };

    const mcpTools = tools
      .map((t) => {
        const name = t.function?.name;
        if (!name) return null;
        const description = t.function?.description || name;
        const shape = jsonSchemaToZodShape(
          t.function?.parameters as Record<string, unknown> | undefined,
        );
        return toolFactory(
          name,
          description,
          shape,
          async (args: Record<string, unknown>) => {
            const id = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
            const pending: ParkedToolCall = {
              id,
              name,
              arguments: JSON.stringify(args ?? {}),
              resolve: () => {},
              reject: () => {},
            };
            const resultPromise = new Promise<string>((resolve, reject) => {
              pending.resolve = resolve;
              pending.reject = reject;
            });
            // Register before notifying so the stream consumer sees the tool.
            pendingTools.set(id, pending);
            onPark();
            const result = await resultPromise;
            return {
              content: [{ type: "text", text: result }],
            };
          },
          { alwaysLoad: true },
        );
      })
      .filter(Boolean);

    const server = createSdkMcpServer({
      name: "opencode",
      alwaysLoad: true,
      tools: mcpTools,
    });

    return { opencode: server };
  } catch (err) {
    log.warn(
      "[opencode-claude] failed to build OpenCode MCP server",
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

/**
 * Buffer a whole turn and answer with one JSON completion. When the turn
 * died without producing any real content, answer with a truthful HTTP error
 * status instead of a fake-200 whose body is just the error text.
 */
async function collectTurnResponse(
  events: AsyncIterable<unknown>,
  model: string,
  bridge: ParkedBridge,
  options?: { suppressReasoning?: boolean },
): Promise<Response> {
  const suppressReasoning = options?.suppressReasoning === true;
  const completionId = `chatcmpl_${createHash("sha1")
    .update(bridge.id)
    .digest("hex")
    .slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  let content = "";
  let reasoning = "";
  let usage: OpenAIUsage | null = null;
  let lastErrorNorm: string | null = null;
  let errorText: string | null = null;
  let sawContent = false;
  const toolCalls: ParkedToolCall[] = [];

  const noteError = (text: string) => {
    const norm = normalizeClaudeErrorText(text);
    if (!norm || norm === lastErrorNorm) return;
    lastErrorNorm = norm;
    errorText = text;
    content += `\n\n[claude-code error] ${text}`;
  };

  try {
    for await (const event of events) {
      const mapped = mapSdkEvent(event, bridge.accountId);
      if (mapped.kind === "park") {
        toolCalls.push(...mapped.tools);
        sawContent = true;
      } else if (mapped.kind === "text") {
        if (mapped.text) sawContent = true;
        content += mapped.text;
      } else if (mapped.kind === "reasoning") {
        if (!suppressReasoning) reasoning += mapped.text;
      } else if (mapped.kind === "usage") {
        usage = mapped.usage;
      } else if (mapped.kind === "error") {
        // SDK emits the failure twice (result event + iterator throw) —
        // keep one copy, and keep any usage that came with it.
        if (mapped.usage) usage = mapped.usage;
        forgetDeadSession(bridge.conversationKey, mapped.text);
        noteError(mapped.text);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordRateLimitErrorText(message, bridge.accountId);
    forgetDeadSession(bridge.conversationKey, message);
    noteError(message);
  }

  if (!sawContent && errorText) {
    return failureResponse(errorText, bridge.conversationKey, bridge.accountId);
  }

  // Usage arrives once per completed Claude turn (the SDK result event), so
  // parked tool segments of the same turn do not inflate the counters.
  if (usage) recordTurnUsage(bridge.accountId, usage);

  return Response.json({
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length
            ? {
                tool_calls: toolCalls.map((t) => ({
                  id: t.id,
                  type: "function",
                  function: { name: t.name, arguments: t.arguments },
                })),
              }
            : {}),
        },
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    ...(usage ? { usage } : {}),
  });
}

/**
 * Hold the response head until the turn proves it is alive (first real
 * content / tool call / successful result). If it dies first, close the
 * generator (killing the CLI process via consumeStream's finally) and report
 * the failure so the caller can answer with a proper HTTP status.
 */
type TurnProbe =
  | { status: "alive"; replay: AsyncIterable<unknown> }
  | { status: "failed"; errorText: string };

function rawProbeKind(event: unknown): "content" | "error" | "neutral" {
  if (!event || typeof event !== "object") return "neutral";
  const e = event as Record<string, unknown>;
  if (e.type === "__park__") return "content";
  if (e.type === "assistant") return "content";
  if (e.type === "result") return e.is_error ? "error" : "content";
  if (e.type === "stream_event" && e.event && typeof e.event === "object") {
    const ev = e.event as Record<string, unknown>;
    if (
      ev.type === "content_block_delta" &&
      ev.delta &&
      typeof ev.delta === "object"
    ) {
      const delta = ev.delta as Record<string, unknown>;
      if (
        delta.type === "text_delta" &&
        typeof delta.text === "string" &&
        delta.text
      ) {
        return "content";
      }
      if (
        (delta.type === "thinking_delta" ||
          delta.type === "reasoning_delta") &&
        typeof (delta.thinking ?? delta.text) === "string" &&
        String(delta.thinking ?? delta.text)
      ) {
        return "content";
      }
    }
    return "neutral";
  }
  if (e.type === "text_delta" && typeof e.text === "string" && e.text) {
    return "content";
  }
  return "neutral";
}

function rawErrorText(event: unknown): string {
  const e = (event ?? {}) as Record<string, unknown>;
  if (typeof e.result === "string" && e.result) return e.result;
  if (typeof e.error === "string" && e.error) return e.error;
  return "Claude turn failed";
}

async function* chainBuffered(
  buffered: unknown[],
  iterator: AsyncIterator<unknown>,
): AsyncGenerator<unknown, void, unknown> {
  for (const event of buffered) yield event;
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      yield next.value;
    }
  } finally {
    try {
      await iterator.return?.(undefined as never);
    } catch {
      // ignore
    }
  }
}

async function probeTurnEvents(
  events: AsyncIterable<unknown>,
): Promise<TurnProbe> {
  const iterator = events[Symbol.asyncIterator]();
  const buffered: unknown[] = [];
  const fail = async (errorText: string): Promise<TurnProbe> => {
    try {
      await iterator.return?.(undefined as never);
    } catch {
      // ignore
    }
    return { status: "failed", errorText };
  };
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const kind = rawProbeKind(next.value);
      if (kind === "error") {
        return fail(rawErrorText(next.value));
      }
      buffered.push(next.value);
      if (kind === "content") {
        return { status: "alive", replay: chainBuffered(buffered, iterator) };
      }
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  return fail("Claude Code ended the turn without any output");
}

/**
 * Truthful HTTP error for a turn that died before producing content.
 * Also records hard subscription limits so the fast-fail gate activates and
 * follow-up requests get a cheap 429 without spawning a doomed CLI turn.
 */
function failureResponse(
  errorText: string,
  conversationKey: string,
  accountId?: string,
): Response {
  recordRateLimitErrorText(errorText, accountId);
  forgetDeadSession(conversationKey, errorText);
  const kind = classifyClaudeFailure(errorText);
  log.warn("[opencode-claude] turn failed fast", {
    kind,
    conversationKey,
    ...(accountId ? { account: accountId } : {}),
    message: errorText.slice(0, 300),
  });

  if (kind === "rate_limit") {
    const snap = getRateLimitSnapshot(Date.now(), accountId);
    const until = snap.limitedUntil ?? snap.resetsAt;
    const retryAfterSeconds =
      until !== undefined
        ? Math.max(1, Math.round((until - Date.now()) / 1000))
        : 600;
    const countdown = formatResetCountdown(retryAfterSeconds * 1000);
    return Response.json(
      {
        error: {
          message: `${errorText} · limit resets in ${countdown}${
            snap.resetsAtISO ? ` (${snap.resetsAtISO})` : ""
          }`,
          type: failureTypeFor(kind),
          code: "claude_session_limit",
          ...(snap.resetsAt !== undefined
            ? { resets_at: new Date(snap.resetsAt).toISOString() }
            : {}),
          retry_after: retryAfterSeconds,
        },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfterSeconds),
          ...(snap.resetsAt !== undefined
            ? {
                "x-claude-rate-limit-reset": new Date(
                  snap.resetsAt,
                ).toISOString(),
              }
            : {}),
        },
      },
    );
  }

  const hint = failureHintFor(kind);
  return Response.json(
    {
      error: {
        message: hint ? `${errorText} ${hint}` : errorText,
        type: failureTypeFor(kind),
        code: kind === "auth" ? "claude_auth" : "claude_turn_failed",
      },
    },
    { status: failureStatusFor(kind) },
  );
}

function streamOpenAIResponse(
  events: AsyncIterable<unknown>,
  model: string,
  bridge: ParkedBridge,
  options?: { suppressReasoning?: boolean },
): Response {
  const suppressReasoning = options?.suppressReasoning === true;
  const completionId = `chatcmpl_${createHash("sha1")
    .update(bridge.id)
    .digest("hex")
    .slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };

      send({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });

      let finishReason: string | null = "stop";
      let usage: OpenAIUsage | null = null;
      let lastErrorNorm: string | null = null;
      const sendError = (text: string) => {
        const norm = normalizeClaudeErrorText(text);
        if (!norm || norm === lastErrorNorm) return;
        lastErrorNorm = norm;
        send({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { content: `\n\n[claude-code error] ${text}` },
              finish_reason: null,
            },
          ],
        });
      };

      try {
        for await (const event of events) {
          const mapped = mapSdkEvent(event, bridge.accountId);
          if (mapped.kind === "park") {
            finishReason = "tool_calls";
            for (let i = 0; i < mapped.tools.length; i++) {
              const tool = mapped.tools[i];
              send({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: i,
                          id: tool.id,
                          type: "function",
                          function: {
                            name: tool.name,
                            arguments: tool.arguments,
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
            }
            break;
          }

          if (mapped.kind === "text" && mapped.text) {
            send({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: mapped.text },
                  finish_reason: null,
                },
              ],
            });
          }

          if (mapped.kind === "reasoning" && mapped.text) {
            if (suppressReasoning) continue;
            send({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { reasoning_content: mapped.text },
                  finish_reason: null,
                },
              ],
            });
          }

          if (mapped.kind === "usage") {
            usage = mapped.usage;
          }

          if (mapped.kind === "error") {
            finishReason = "stop";
            if (mapped.usage) usage = mapped.usage;
            forgetDeadSession(bridge.conversationKey, mapped.text);
            log.warn("[opencode-claude] mid-stream turn error", {
              conversationKey: bridge.conversationKey,
              kind: classifyClaudeFailure(mapped.text),
              message: mapped.text.slice(0, 300),
            });
            sendError(mapped.text);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A limit/result failure typically arrives here right after the SDK
        // emitted the same text as a result event — dedupe via sendError.
        recordRateLimitErrorText(message, bridge.accountId);
        forgetDeadSession(bridge.conversationKey, message);
        log.warn("[opencode-claude] stream iterator failed", {
          conversationKey: bridge.conversationKey,
          kind: classifyClaudeFailure(message),
          message: message.slice(0, 300),
        });
        sendError(message);
        finishReason = "stop";
      }

      send({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      });
      // Same rule as the buffered path: only a turn that reported usage is a
      // completed turn, so parked tool segments are not counted twice.
      if (usage) recordTurnUsage(bridge.accountId, usage);
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      ...SSE_HEADERS,
      ...(bridge.accountId ? { [ACCOUNT_HEADER]: bridge.accountId } : {}),
    },
  });
}

type MappedEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "park"; tools: ParkedToolCall[] }
  | { kind: "usage"; usage: OpenAIUsage }
  | { kind: "error"; text: string; usage?: OpenAIUsage | null }
  | { kind: "ignore" };

/** claude CLI text when `resume` points at a session it cannot load. */
const LOST_SESSION_PATTERN =
  /no conversation found|session\b.*\bnot found|could not (?:find|load|resume).*(?:session|conversation)/i;

/**
 * A resume-target-missing error means the stored foreign session id is dead.
 * Clear it so the next turn transfers history instead of failing forever.
 */
function forgetDeadSession(conversationKey: string, errorText: string): void {
  if (!LOST_SESSION_PATTERN.test(errorText)) return;
  log.warn("[opencode-claude] Claude session lost; clearing stored binding", {
    conversationKey,
  });
  clearForeignSessionId(conversationKey);
}

/**
 * Map Claude Agent SDK events to OpenAI-style deltas.
 *
 * Prefer `stream_event` content_block_delta for text/reasoning. Full
 * `assistant` message payloads repeat the same content after partials and
 * would double-print if both were forwarded.
 */
function mapSdkEvent(event: unknown, accountId?: string): MappedEvent {
  if (!event || typeof event !== "object") return { kind: "ignore" };
  const e = event as Record<string, unknown>;

  if (e.type === "__park__" && Array.isArray(e.tools)) {
    return { kind: "park", tools: e.tools as ParkedToolCall[] };
  }

  // Structured subscription limit telemetry from the Agent SDK — record for
  // the /v1/rate-limit counter; surface a note only on meaningful changes.
  // The note decision must use THIS event's own payload (fresh), never
  // merged store history — see maybeRateLimitNote.
  if (e.type === "rate_limit_event") {
    const rawInfo =
      e.rate_limit_info && typeof e.rate_limit_info === "object"
        ? (e.rate_limit_info as Record<string, unknown>)
        : undefined;
    const state = recordRateLimitInfo(rawInfo, accountId);
    // Keep the "how much is left" view fresh for free during ordinary turns.
    // The event carries one window, so this merges rather than replaces.
    mergeSdkRateLimitEvent(accountId, rawInfo);
    const note = maybeRateLimitNote(state, rawInfo, accountId);
    if (!note) return { kind: "ignore" };
    // Say what is LEFT, in the session itself, across both windows — the
    // number the operator acts on, without opening the panel.
    const summary = formatQuotaSummary(getAccountQuota(accountId));
    return {
      kind: "reasoning",
      text: summary ? `${note.replace(/\n$/, "")} · ${summary}\n` : note,
    };
  }

  // Auto-compact boundary — surface as a short reasoning note for the UI.
  if (e.type === "system" && e.subtype === "compact_boundary") {
    return {
      kind: "reasoning",
      text: formatCompactNote(e.compact_metadata),
    };
  }

  if (e.type === "system" && e.status === "compacting") {
    return { kind: "reasoning", text: "[compact] Compacting context…\n" };
  }

  // stream_event / partial message deltas (authoritative while streaming)
  if (e.type === "stream_event" && e.event && typeof e.event === "object") {
    const ev = e.event as Record<string, unknown>;
    if (ev.type === "content_block_delta" && ev.delta && typeof ev.delta === "object") {
      const delta = ev.delta as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        return { kind: "text", text: delta.text };
      }
      if (
        (delta.type === "thinking_delta" || delta.type === "reasoning_delta") &&
        typeof (delta.thinking ?? delta.text) === "string"
      ) {
        return {
          kind: "reasoning",
          text: String(delta.thinking ?? delta.text),
        };
      }
    }
    return { kind: "ignore" };
  }

  // Assistant messages: skip text/thinking replay (already streamed via
  // stream_event). Tool-use blocks are handled by the MCP park path.
  if (e.type === "assistant") {
    return { kind: "ignore" };
  }

  if (e.type === "result") {
    const usage = usageFromSdkResult(event);
    if (e.is_error) {
      const text =
        typeof e.result === "string"
          ? e.result
          : typeof e.error === "string"
            ? e.error
            : "Claude turn failed";
      // Hard subscription limit? Record it so the gate + counter activate.
      const limited = recordRateLimitErrorText(text, accountId);
      let note = text;
      if (limited?.limited) {
        const until = limited.limitedUntil ?? limited.resetsAt;
        if (until !== undefined) {
          const wait = formatResetCountdown(Math.max(0, until - Date.now()));
          note = `${text} · limit resets in ${wait}${
            limited.resetsAt
              ? ` (${new Date(limited.resetsAt).toISOString()})`
              : ""
          }`;
        }
      }
      return { kind: "error", text: note, usage };
    }
    if (usage) return { kind: "usage", usage };
    return { kind: "ignore" };
  }

  // Fallback for SDK builds that emit bare text deltas without stream_event
  if (typeof e.text === "string" && e.type === "text_delta") {
    return { kind: "text", text: e.text };
  }

  return { kind: "ignore" };
}
