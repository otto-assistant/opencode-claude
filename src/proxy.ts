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

const FIXED_PROXY_PORT = Number(process.env.OPENCODE_CLAUDE_PROXY_PORT || 0);
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
  const port = proxyPort ?? (FIXED_PROXY_PORT || 3457);
  return `http://127.0.0.1:${port}/v1`;
}

export function getProxyPort(): number | null {
  return proxyPort;
}

export async function startProxy(tokenProvider: TokenProvider): Promise<number> {
  getAccessToken = tokenProvider;
  if (server && proxyPort) return proxyPort;

  const hostname = "127.0.0.1";
  const preferred = FIXED_PROXY_PORT > 0 ? FIXED_PROXY_PORT : 0;

  server = Bun.serve({
    hostname,
    port: preferred,
    async fetch(req) {
      return handleRequest(req);
    },
  });
  proxyPort = server.port ?? null;
  if (proxyPort == null) {
    throw new Error("Failed to bind Claude Code proxy port");
  }
  log.info(`[opencode-claude] proxy listening on ${getClaudeProxyBaseUrl()}`);
  return proxyPort;
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
  const existing = findBridgeByConversation(conversationKey);
  if (existing && existing.pendingTools.size > 0) {
    const results = collectToolResults(messages);
    for (const [toolId, tool] of existing.pendingTools) {
      const result = results.get(toolId);
      if (result !== undefined) {
        tool.resolve(result);
        existing.pendingTools.delete(toolId);
      }
    }
    if (existing.pendingTools.size === 0 && existing.continueStream) {
      return streamOpenAIResponse(
        existing.continueStream(),
        body.model || model,
        stream,
        existing,
      );
    }
  }

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

  const mcpServers =
    openCodeTools.length > 0
      ? await buildOpenCodeMcpServer(openCodeTools, pendingTools, () => {
          parked = true;
        })
      : undefined;

  handle = await startClaudeQuery({
    prompt,
    cwd,
    model,
    resume,
    effort: selection.effort,
    env,
    mcpServers,
    // When OpenCode supplies tools, prefer those via MCP and keep Claude
    // permissions interactive-safe. Claude native tools still load from
    // settings unless we restrict allowedTools — leave defaults so skills /
    // project MCP from the harness still participate.
    permissionMode: openCodeTools.length > 0 ? "default" : "acceptEdits",
    systemPrompt: { type: "preset", preset: "claude_code" },
  });

  const bridge: ParkedBridge = {
    id: bridgeId,
    conversationKey,
    handle,
    pendingTools,
    createdAt: Date.now(),
  };
  putBridge(bridge);

  async function* consume(): AsyncGenerator<unknown, void, unknown> {
    try {
      for await (const event of handle!.stream) {
        const sessionId = extractSessionId(event);
        if (sessionId) {
          setForeignSessionId(conversationKey, sessionId, {
            modelId: model,
            cwd,
          });
        }

        // If tools were parked mid-stream, stop yielding so the HTTP response
        // can close with tool_calls; continueStream resumes later.
        if (parked && pendingTools.size > 0) {
          yield { type: "__park__", tools: [...pendingTools.values()] };
          return;
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
    try {
      for await (const event of handle!.stream) {
        const sessionId = extractSessionId(event);
        if (sessionId) {
          setForeignSessionId(conversationKey, sessionId, {
            modelId: model,
            cwd,
          });
        }
        if (parked && pendingTools.size > 0) {
          yield { type: "__park__", tools: [...pendingTools.values()] };
          return;
        }
        yield event;
      }
    } finally {
      if (!parked) {
        handle?.close();
        deleteBridge(bridgeId);
      }
    }
  };

  return streamOpenAIResponse(consume(), body.model || model, stream, bridge);
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
    const createSdkMcpServer = (sdk as { createSdkMcpServer?: Function })
      .createSdkMcpServer;
    const toolFactory = (sdk as { tool?: Function }).tool;
    if (typeof createSdkMcpServer !== "function" || typeof toolFactory !== "function") {
      log.warn("[opencode-claude] SDK MCP helpers unavailable; OpenCode tools disabled");
      return undefined;
    }

    const mcpTools = tools
      .map((t) => {
        const name = t.function?.name;
        if (!name) return null;
        const description = t.function?.description || name;
        const schema = t.function?.parameters || { type: "object", properties: {} };
        return toolFactory(
          name,
          description,
          schema,
          async (args: Record<string, unknown>) => {
            const id = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
            onPark();
            const result = await new Promise<string>((resolve, reject) => {
              pendingTools.set(id, {
                id,
                name,
                arguments: JSON.stringify(args ?? {}),
                resolve,
                reject,
              });
            });
            return {
              content: [{ type: "text", text: result }],
            };
          },
        );
      })
      .filter(Boolean);

    const server = createSdkMcpServer({
      name: "opencode",
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

function mapSdkEvent(event: unknown): MappedEvent {
  if (!event || typeof event !== "object") return { kind: "ignore" };
  const e = event as Record<string, unknown>;

  if (e.type === "__park__" && Array.isArray(e.tools)) {
    return { kind: "park", tools: e.tools as ParkedToolCall[] };
  }

  // stream_event / partial message deltas
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
  }

  // Assistant message with content blocks
  if (e.type === "assistant" && e.message && typeof e.message === "object") {
    const message = e.message as { content?: unknown };
    const blocks = Array.isArray(message.content) ? message.content : [];
    let text = "";
    let reasoning = "";
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") text += b.text;
      if (b.type === "thinking" && typeof b.thinking === "string") {
        reasoning += b.thinking;
      }
    }
    if (reasoning) return { kind: "reasoning", text: reasoning };
    if (text) return { kind: "text", text };
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

  // Partial message convenience fields used by some SDK builds
  if (typeof e.text === "string" && e.type === "text_delta") {
    return { kind: "text", text: e.text };
  }

  return { kind: "ignore" };
}
