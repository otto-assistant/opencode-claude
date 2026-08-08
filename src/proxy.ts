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
import {
  deleteBridge,
  findBridgeByConversation,
  findBridgeByPendingTool,
  putBridge,
  type ParkedBridge,
  type ParkedToolCall,
} from "./bridge-pool.js";
import { withClaudeOAuthToken } from "./auth-env.js";
import {
  decodeClaudeModelSelection,
  EFFORT_HEADER,
} from "./model-selection.js";
import { resolveClaudeModelId } from "./models.js";
import { SESSION_HEADER, type ClaudeEffort } from "./constants.js";
import { startClaudeQuery, type ClaudeQueryHandle } from "./query.js";
import {
  conversationKeyFromMessages,
  getForeignSessionId,
  setForeignSessionId,
} from "./session-store.js";
import { log } from "./log.js";
import {
  getRateLimitSnapshot,
  maybeRateLimitNote,
  normalizeClaudeErrorText,
  rateLimitGate,
  recordRateLimitErrorText,
  recordRateLimitInfo,
  formatResetCountdown,
} from "./rate-limit.js";
import {
  extractTextContent,
  latestUserPrompt,
  promptAsStream,
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

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

type TokenProvider = () => Promise<string | null>;

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

export async function startProxy(tokenProvider: TokenProvider): Promise<number> {
  getAccessToken = tokenProvider;
  if (server && proxyPort) return proxyPort;

  // Only reuse a sibling listener when the operator pinned a port.
  if (REQUESTED_PROXY_PORT > 0) {
    const pinnedUrl = `http://127.0.0.1:${REQUESTED_PROXY_PORT}/v1`;
    if (await isProxyHealthyAt(pinnedUrl)) {
      proxyPort = REQUESTED_PROXY_PORT;
      log.info(`[opencode-claude] reusing healthy proxy on ${pinnedUrl}`);
      return proxyPort;
    }
  }

  const hostname = "127.0.0.1";
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
    log.info(`[opencode-claude] proxy listening on ${getClaudeProxyBaseUrl()}`);
    return proxyPort;
  } catch (err) {
    if (
      REQUESTED_PROXY_PORT > 0 &&
      isAddrInUseError(err) &&
      (await isProxyHealthyAt(`http://127.0.0.1:${REQUESTED_PROXY_PORT}/v1`))
    ) {
      proxyPort = REQUESTED_PROXY_PORT;
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

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
    const rateLimit = getRateLimitSnapshot();
    return Response.json({
      ok: true,
      provider: "claude-code",
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
  if (
    req.method === "GET" &&
    (url.pathname === "/rate-limit" || url.pathname === "/v1/rate-limit")
  ) {
    return Response.json(getRateLimitSnapshot());
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
): { modelId: string; effort?: ClaudeEffort } {
  const header = req.headers.get(EFFORT_HEADER);
  const decoded = decodeClaudeModelSelection(header);
  const modelId =
    decoded?.modelId ||
    (typeof body.model === "string" ? body.model.replace(/^claude-code\//, "") : "sonnet");
  const effort = decoded?.effort;
  return { modelId, ...(effort ? { effort } : {}) };
}

async function handleChatCompletions(
  req: Request,
  body: ChatCompletionRequest,
): Promise<Response> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const metaKind = detectMetaRequestKind(messages);
  const sessionHeader = req.headers.get(SESSION_HEADER);
  const conversationKey =
    requestKeyNamespace(metaKind) +
    (sessionHeader || conversationKeyFromMessages(messages));
  const selection = selectionFromRequest(req, body);
  const model = resolveClaudeModelId(selection.modelId);
  const stream = body.stream !== false;

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
      return streamOpenAIResponse(
        existing.continueStream(),
        body.model || model,
        stream,
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
      return streamOpenAIResponse(
        (async function* () {
          yield { type: "__park__", tools: [...existing!.pendingTools.values()] };
        })(),
        body.model || model,
        stream,
        existing,
      );
    }
  }

  log.info("[opencode-claude] chat completions", {
    conversationKey,
    sessionHeader,
    metaKind,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    messageCount: messages.length,
    hasToolResults: toolResults.size > 0,
    bridgePending: existing?.pendingTools.size ?? 0,
  });

  const accessToken = getAccessToken ? await getAccessToken() : null;

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

    return metaChatCompletionResponse({
      stream,
      id: completionId,
      model: responseModel,
      content,
      usage,
    });
  }

  const env = accessToken
    ? withClaudeOAuthToken(accessToken)
    : withClaudeOAuthToken("", process.env);

  if (!accessToken) {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  const openCodeTools = Array.isArray(body.tools) ? body.tools : [];
  const cwd = process.env.OPENCODE_CLAUDE_CWD || process.cwd();
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
  const gate = rateLimitGate();
  if (gate.blocked) {
    log.warn("[opencode-claude] rate-limit gate blocked a turn", {
      conversationKey,
      retryAfterSeconds: gate.retryAfterSeconds,
    });
    return Response.json(
      {
        error: {
          message: gate.message,
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
          ...(gate.resetsAt !== undefined
            ? { "x-claude-rate-limit-reset": new Date(gate.resetsAt).toISOString() }
            : {}),
        },
      },
    );
  }

  const resume = getForeignSessionId(conversationKey);

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
    typeof prompt === "string" ? prompt || " " : promptAsStream(prompt);

  const hasTodoWrite = openCodeToolNames.includes("todowrite");
  handle = await queryStarter({
    prompt: queryPrompt,
    cwd,
    model,
    resume,
    effort: selection.effort,
    env,
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

  return streamOpenAIResponse(
    consumeStream(),
    body.model || model,
    stream,
    bridge,
  );
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

function streamOpenAIResponse(
  events: AsyncIterable<unknown>,
  model: string,
  stream: boolean,
  bridge: ParkedBridge,
  options?: { suppressReasoning?: boolean },
): Response {
  const suppressReasoning = options?.suppressReasoning === true;
  const completionId = `chatcmpl_${createHash("sha1")
    .update(bridge.id)
    .digest("hex")
    .slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    // Buffer the full completion then return JSON (non-streaming clients).
    const collect = async (): Promise<string> => {
      let content = "";
      let reasoning = "";
      let usage: OpenAIUsage | null = null;
      let lastErrorNorm: string | null = null;
      const toolCalls: ParkedToolCall[] = [];
      for await (const event of events) {
        const mapped = mapSdkEvent(event);
        if (mapped.kind === "park") {
          toolCalls.push(...mapped.tools);
        } else if (mapped.kind === "text") {
          content += mapped.text;
        } else if (mapped.kind === "reasoning") {
          if (!suppressReasoning) reasoning += mapped.text;
        } else if (mapped.kind === "usage") {
          usage = mapped.usage;
        } else if (mapped.kind === "error") {
          // SDK emits the failure twice (result event + iterator throw) —
          // keep one copy, and keep any usage that came with it.
          if (mapped.usage) usage = mapped.usage;
          const norm = normalizeClaudeErrorText(mapped.text);
          if (norm && norm !== lastErrorNorm) {
            lastErrorNorm = norm;
            content += `\n\n[claude-code error] ${mapped.text}`;
          }
        }
      }
      return JSON.stringify({
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
    };

    // Kick off collection; Response accepts a Promise body via async IIFE wrapped
    // in a stream for type-safe BodyInit.
    const bodyStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const json = await collect();
          controller.enqueue(new TextEncoder().encode(json));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          recordRateLimitErrorText(message);
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                error: { message, type: "server_error" },
              }),
            ),
          );
        } finally {
          controller.close();
        }
      },
    });
    return new Response(bodyStream, {
      headers: { "Content-Type": "application/json" },
    });
  }

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
          const mapped = mapSdkEvent(event);
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
            sendError(mapped.text);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A limit/result failure typically arrives here right after the SDK
        // emitted the same text as a result event — dedupe via sendError.
        recordRateLimitErrorText(message);
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
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(readable, { headers: SSE_HEADERS });
}

type MappedEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "park"; tools: ParkedToolCall[] }
  | { kind: "usage"; usage: OpenAIUsage }
  | { kind: "error"; text: string; usage?: OpenAIUsage | null }
  | { kind: "ignore" };

/**
 * Map Claude Agent SDK events to OpenAI-style deltas.
 *
 * Prefer `stream_event` content_block_delta for text/reasoning. Full
 * `assistant` message payloads repeat the same content after partials and
 * would double-print if both were forwarded.
 */
function mapSdkEvent(event: unknown): MappedEvent {
  if (!event || typeof event !== "object") return { kind: "ignore" };
  const e = event as Record<string, unknown>;

  if (e.type === "__park__" && Array.isArray(e.tools)) {
    return { kind: "park", tools: e.tools as ParkedToolCall[] };
  }

  // Structured subscription limit telemetry from the Agent SDK — record for
  // the /v1/rate-limit counter; surface a note only on meaningful changes.
  if (e.type === "rate_limit_event") {
    const state = recordRateLimitInfo(e.rate_limit_info);
    const note = maybeRateLimitNote(state);
    return note ? { kind: "reasoning", text: note } : { kind: "ignore" };
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
      const limited = recordRateLimitErrorText(text);
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
