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

const DEFAULT_PROXY_PORT = 8787;
const SHARED_PROXY_HEALTH_TIMEOUT_MS = 750;

/**
 * Fixed port the proxy binds to. OpenCode resolves the provider base URL from
 * static config, so the proxy must listen on a deterministic port that matches
 * that URL (a random port leaves the SDK unable to connect).
 * Override with OPENCODE_CLAUDE_PROXY_PORT if 8787 is taken.
 */
const CLAUDE_PROXY_PORT: number = (() => {
  const raw = process.env.OPENCODE_CLAUDE_PROXY_PORT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536
    ? parsed
    : DEFAULT_PROXY_PORT;
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

export function getClaudeProxyBaseUrl(): string {
  return `http://127.0.0.1:${CLAUDE_PROXY_PORT}/v1`;
}

export function getProxyPort(): number | null {
  return proxyPort ?? CLAUDE_PROXY_PORT;
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

async function isSharedProxyHealthy(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SHARED_PROXY_HEALTH_TIMEOUT_MS,
  );
  try {
    const res = await fetch(`${getClaudeProxyBaseUrl()}/models`, {
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

  if (await isSharedProxyHealthy()) {
    proxyPort = CLAUDE_PROXY_PORT;
    log.info(
      `[opencode-claude] reusing healthy proxy on ${getClaudeProxyBaseUrl()}`,
    );
    return proxyPort;
  }

  const hostname = "127.0.0.1";

  try {
    server = Bun.serve({
      hostname,
      port: CLAUDE_PROXY_PORT,
      async fetch(req) {
        return handleRequest(req);
      },
    });
    proxyPort = server.port ?? CLAUDE_PROXY_PORT;
    log.info(`[opencode-claude] proxy listening on ${getClaudeProxyBaseUrl()}`);
    return proxyPort;
  } catch (err) {
    if (isAddrInUseError(err) && (await isSharedProxyHealthy())) {
      proxyPort = CLAUDE_PROXY_PORT;
      log.info(
        `[opencode-claude] port ${CLAUDE_PROXY_PORT} in use; reusing existing proxy`,
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
    return Response.json({ ok: true, provider: "claude-code" });
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

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as { type?: string; text?: string };
      if (p.type === "text" && typeof p.text === "string") return p.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function latestUserPrompt(messages: OpenAIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "user") {
      const text = extractTextContent(msg.content).trim();
      if (text) return text;
    }
  }
  return "";
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
  const conversationKey =
    req.headers.get(SESSION_HEADER) ||
    conversationKeyFromMessages(messages);
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
    if (resolved === 0) {
      log.info("[opencode-claude] re-emitting parked tool_calls", {
        conversationKey: existing.conversationKey,
        pending: existing.pendingTools.size,
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
    sessionHeader: req.headers.get(SESSION_HEADER),
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    messageCount: messages.length,
    hasToolResults: toolResults.size > 0,
    bridgePending: existing?.pendingTools.size ?? 0,
  });

  // Note: an in-flight bridge (pendingTools empty) is left alone here; putBridge
  // supersedes same-conversation bridges when a new turn actually starts.

  const accessToken = getAccessToken ? await getAccessToken() : null;
  const env = accessToken
    ? withClaudeOAuthToken(accessToken)
    : withClaudeOAuthToken("", process.env);

  // Empty token → still strip API keys; CLI credentials on disk may auth.
  if (!accessToken) {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  const openCodeTools = Array.isArray(body.tools) ? body.tools : [];
  const prompt = latestUserPrompt(messages);
  if (!prompt && openCodeTools.length === 0) {
    return Response.json(
      { error: { message: "No user message found", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  const resume = getForeignSessionId(conversationKey);
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

  const mcpServers =
    openCodeTools.length > 0
      ? await buildOpenCodeMcpServer(openCodeTools, pendingTools, notifyPark)
      : undefined;

  // When OpenCode supplies tools, Claude must not run its own Bash/Read/etc.
  // Disable built-ins (`tools: []`) and only expose the OpenCode MCP bridge.
  const bridgeOpenCodeTools = openCodeTools.length > 0;
  const openCodeToolNames = openCodeTools
    .map((t) => t.function?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  const toolAliases = bridgeOpenCodeTools
    ? Object.fromEntries(
        openCodeToolNames.flatMap((name) => {
          const mcpName = `mcp__opencode__${name}`;
          // Redirect common Claude Code capitalizations to the MCP bridge.
          const aliases: Array<[string, string]> = [[name, mcpName]];
          const titled = name.charAt(0).toUpperCase() + name.slice(1);
          if (titled !== name) aliases.push([titled, mcpName]);
          if (name === "bash") aliases.push(["Bash", mcpName]);
          if (name === "read") aliases.push(["Read", mcpName]);
          if (name === "edit") aliases.push(["Edit", mcpName]);
          if (name === "write") aliases.push(["Write", mcpName]);
          if (name === "glob") aliases.push(["Glob", mcpName]);
          if (name === "grep") aliases.push(["Grep", mcpName]);
          return aliases;
        }),
      )
    : undefined;

  handle = await startClaudeQuery({
    prompt,
    cwd,
    model,
    resume,
    effort: selection.effort,
    env,
    mcpServers,
    // OpenCode owns tool execution for bridged MCP tools.
    tools: bridgeOpenCodeTools ? [] : undefined,
    toolAliases,
    allowedTools: bridgeOpenCodeTools
      ? openCodeToolNames.map((n) => `mcp__opencode__${n}`)
      : undefined,
    permissionMode: bridgeOpenCodeTools
      ? "bypassPermissions"
      : "acceptEdits",
    allowDangerouslySkipPermissions: bridgeOpenCodeTools,
    // canUseTool is ignored under bypassPermissions; omit it to avoid SDK warnings.
    ...(bridgeOpenCodeTools
      ? {}
      : {
          canUseTool: async (
            toolName: string,
            input: Record<string, unknown>,
          ) => ({ behavior: "allow" as const, updatedInput: input }),
        }),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(bridgeOpenCodeTools
        ? {
            append:
              "You are running inside OpenCode. Built-in Claude Code tools are disabled. Use only the mcp__opencode__* tools provided for this turn; they execute via OpenCode.",
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
): Response {
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
      const toolCalls: ParkedToolCall[] = [];
      for await (const event of events) {
        const mapped = mapSdkEvent(event);
        if (mapped.kind === "park") {
          toolCalls.push(...mapped.tools);
        } else if (mapped.kind === "text") {
          content += mapped.text;
        } else if (mapped.kind === "reasoning") {
          reasoning += mapped.text;
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

          if (mapped.kind === "error") {
            finishReason = "stop";
            send({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: `\n\n[claude-code error] ${mapped.text}` },
                  finish_reason: null,
                },
              ],
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { content: `\n\n[claude-code error] ${message}` },
              finish_reason: null,
            },
          ],
        });
      }

      send({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
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
  | { kind: "error"; text: string }
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

  if (e.type === "result" && e.is_error) {
    const text =
      typeof e.result === "string"
        ? e.result
        : typeof e.error === "string"
          ? e.error
          : "Claude turn failed";
    return { kind: "error", text };
  }

  // Fallback for SDK builds that emit bare text deltas without stream_event
  if (typeof e.text === "string" && e.type === "text_delta") {
    return { kind: "text", text: e.text };
  }

  return { kind: "ignore" };
}
