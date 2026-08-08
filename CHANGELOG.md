# Changelog

## 0.7.1

- **Rate-limit counter + gate**: structured SDK `rate_limit_event`s and hard
  session-limit errors are recorded to `~/.local/share/opencode-claude/rate-limit.json`
  with the parsed reset time (e.g. "resets 1:10am (Europe/Kyiv)"); new
  `GET /v1/rate-limit` endpoint (plus `/health.rateLimit`) exposes
  `limited / status / utilization / resetsAt / resetInSeconds` so UIs can show
  a live "limits are back" countdown; while a confirmed hard limit is active,
  new turns fail fast with HTTP 429 + `Retry-After` (+ `x-claude-rate-limit-reset`)
  instead of spawning a doomed Agent SDK turn — meta/title requests are never
  gated, and the block self-heals at reset time
  (`OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL=0` disables the gate)
- **Single error emission**: limit/turn failures were streamed twice (SDK
  `result` error event + iterator throw); duplicates are now normalized away,
  the streamed note includes the reset countdown, and token `usage` is
  forwarded even on error results
- **Plan persistence**: `TodoWrite`/`TodoRead` now alias to OpenCode's
  `todowrite`/`todoread` bridge tools, and the OpenCode system-prompt append
  requires writing multi-step plans via `mcp__opencode__todowrite` (text-only
  plans died with the turn) plus batching independent tool calls per turn
- Repo dev config `.opencode/opencode.json` pins the npm package again
  (was a sandbox-only `file:///workspace` path), so `scripts/update-plugin.sh`
  works
- Haiku live matrix: `/v1/rate-limit` shape + recorded-telemetry cases

## 0.7.0

- Proxy port is dynamic by default (ephemeral bind); live `baseURL` is published via config + auth loader. Optional pin: `OPENCODE_CLAUDE_PROXY_PORT`
- Fix file/PDF attachments: accept OpenAI `file.file_data` and seed `modalities.input` with `pdf` so OpenCode does not strip documents
- Fix image attachments: convert AI SDK `{ type: "image" }` parts (previously detected then dropped); tolerate data-URL name params
- Surface OpenAI-compatible `usage` (tokens + cost_usd + model_usage) from Agent SDK result events; richer compact notes with token counts
- Live Haiku matrix (`bun run test:haiku`): attachments, tools/MCP park-resume, session resume, context/usage, OpenCode CLI `--file`
- Logging: warn/error always on stderr; info gated by `OPENCODE_CLAUDE_DEBUG`; durable mirror at `~/.local/share/opencode-claude/debug.log`; config hook no longer dies on proxy bind errors
- README + package description aligned with opencode-cursor style (header, badges, effort docs)
- Effort variants `low`→`max` exposed as OpenCode model variants (disable generic `none`/`minimal`)
- Multimodal prompts: OpenAI `image_url` / file parts → Claude image & document blocks
- Auto-compact enabled; compact boundary events surfaced in the stream
- Static provider config seeds modalities + variants so attachments and effort survive OpenCode's config path

## 0.5.0

- See GitHub releases

## 0.1.0

- Initial `@otto-assistant/opencode-claude` plugin
- Claude Agent SDK proxy (OpenChamber harness approach)
- Claude CLI credential sync + Pro/Max browser OAuth
- Model catalog with effort variants (`low` → `max`)
- OpenCode tool parking via in-process MCP bridge
- Sticky Claude session resume
