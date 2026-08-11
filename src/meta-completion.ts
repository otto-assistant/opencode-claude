import { spawnSync } from "node:child_process"
import { findBinaryOnPath } from "./executable-path.js"
import { buildMetaPrompt, type MetaRequestKind } from "./request-kind.js"

type MetaMessagesBody = {
  messages?: Array<{ role?: string; content?: unknown }>
}

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
const ANTHROPIC_VERSION = "2023-06-01"
const OAUTH_BETA = "oauth-2025-04-20"

/**
 * Requests carrying a Claude Code OAuth token must be indistinguishable from
 * genuine Claude Code CLI traffic: the CLI's system prompt preamble is
 * required (the API rejects/flags OAuth inference without it), and the
 * headers mirror what the CLI's own SDK stack sends.
 */
const CLAUDE_CODE_SYSTEM_PREAMBLE =
  "You are Claude Code, Anthropic's official CLI."

let cliVersion: string | null = null

/** CLI version for the user-agent (cosmetic only — never auth-relevant). */
function claudeCliUserAgent(): string {
  if (!cliVersion) {
    try {
      const bin = findBinaryOnPath("claude", process.env)
      if (bin) {
        const out = spawnSync(bin, ["--version"], {
          encoding: "utf8",
          timeout: 4000,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        })
        const match = `${out.stdout || ""}`.trim().match(/(\d+\.\d+\.\d+)/)
        cliVersion = match?.[1] ?? null
      }
    } catch {
      cliVersion = null
    }
    if (!cliVersion) cliVersion = "2.0.0"
  }
  return `claude-cli/${cliVersion} (external, cli)`
}

export type MetaCompletionResult = {
  text: string
  model: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
  }
}

/**
 * Fast path for OpenCode meta requests (title / summary).
 * Uses the Anthropic Messages API with the Claude Code OAuth token —
 * much faster than the Agent SDK, which is required so OpenCode receives
 * the title before it disposes the session.
 */
export async function completeMetaRequest(params: {
  body: MetaMessagesBody
  kind: Exclude<MetaRequestKind, null>
  accessToken: string
  model?: string
  signal?: AbortSignal
}): Promise<MetaCompletionResult> {
  const { system, prompt } = buildMetaPrompt(
    Array.isArray(params.body.messages) ? params.body.messages : [],
  )
  const model = params.model ?? "claude-haiku-4-5"
  const maxTokens = params.kind === "title" ? 64 : 1024

  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${params.accessToken}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": OAUTH_BETA,
      "anthropic-dangerous-direct-browser-access": "true",
      "user-agent": claudeCliUserAgent(),
      "x-app": "cli",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0,
      // Claude Code sends its system prompt as an array whose first block is
      // always the CLI preamble; the caller's instruction follows.
      system: [
        { type: "text", text: CLAUDE_CODE_SYSTEM_PREAMBLE },
        { type: "text", text: system },
      ],
      messages: [{ role: "user", content: prompt }],
    }),
    signal: params.signal,
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => "")
    throw new Error(`Anthropic meta completion failed (${response.status}): ${errText.slice(0, 400)}`)
  }

  const data = (await response.json()) as {
    model?: string
    content?: Array<{ type?: string; text?: string }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }

  const raw = (data.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("")
    .trim()

  return {
    text: sanitizeMetaOutput(raw, params.kind, prompt),
    model: data.model ?? model,
    usage: {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
    },
  }
}

/** Strip quotes / fences; fall back to a short heuristic title if empty. */
export function sanitizeMetaOutput(
  text: string,
  kind: Exclude<MetaRequestKind, null>,
  fallbackUser?: string,
): string {
  let cleaned = text
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^```[\w]*\n?|\n?```$/g, "")
    .replace(/^(title|summary)\s*:\s*/i, "")
    .trim()

  if (kind === "title") {
    // Keep to a single line; OpenCode stores this as the session name.
    cleaned = cleaned.split(/\r?\n/)[0]?.trim() ?? ""
    if (cleaned.length > 80) cleaned = `${cleaned.slice(0, 77).trimEnd()}...`
  }

  if (cleaned) return cleaned
  if (kind === "title" && fallbackUser) return heuristicTitle(fallbackUser)
  return cleaned
}

export function heuristicTitle(userText: string): string {
  const line = userText
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
  if (!line) return "New session"
  return line.length < userText.trim().length ? `${line}...` : line
}

/** Build an OpenAI-compatible chat.completion Response (JSON or SSE). */
export function metaChatCompletionResponse(params: {
  stream: boolean
  id: string
  model: string
  content: string
  usage?: { prompt_tokens: number; completion_tokens: number }
}): Response {
  const created = Math.floor(Date.now() / 1000)
  const usage = {
    prompt_tokens: params.usage?.prompt_tokens ?? 0,
    completion_tokens: params.usage?.completion_tokens ?? 0,
    total_tokens:
      (params.usage?.prompt_tokens ?? 0) + (params.usage?.completion_tokens ?? 0),
  }

  if (!params.stream) {
    return Response.json({
      id: params.id,
      object: "chat.completion",
      created,
      model: params.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: params.content },
          finish_reason: "stop",
        },
      ],
      usage,
    })
  }

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        )
      }
      send({
        id: params.id,
        object: "chat.completion.chunk",
        created,
        model: params.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: params.content },
            finish_reason: null,
          },
        ],
      })
      send({
        id: params.id,
        object: "chat.completion.chunk",
        created,
        model: params.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
      })
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}
