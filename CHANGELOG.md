# Changelog

## 0.9.1

- **Fail-fast on dead turns**: a Claude turn that dies before producing any
  content (bad/revoked token, session limit, spawn failure) used to be
  streamed back as a fake-200 response whose only "assistant text" was the
  error message. Hosts retried those turns in a loop, and each retry
  re-sent the entire conversation context to Anthropic — burning quota for
  zero output (observed: ~4% of a weekly usage cap in one incident). The
  proxy now probes the turn before committing the response head and answers
  with a truthful HTTP status: 401 for auth failures, 429 + Retry-After for
  subscription limits (also activating the fast-fail gate), 500 otherwise.
  Errors after content is already streaming stay inline as before.
- **Pre-flight auth check**: with no credentials at all, the proxy returns
  401 immediately instead of spawning a doomed CLI turn.
- **Single-flight token refresh**: OpenCode fires the main turn and the
  title/summary request in parallel; both used to refresh the same OAuth
  token concurrently. Anthropic rotates the refresh token on every use, so
  the loser replayed a stale token — treated as token theft and the whole
  grant got revoked (invalid_grant → revoked chain). Refreshes are now
  deduped per refresh token, run with a 2-minute margin before expiry, and
  re-read the auth store after a rejection (a sibling process may already
  have rotated).
- **Chain ownership**: CLI-synced credentials are tagged (`cli-shared-` /
  `cli-sync-`) and never rotated through the token endpoint by the plugin —
  the CLI stays the sole owner of its chain. Expired CLI credentials are no
  longer synced (they shadowed healthy creds and blocked the CLI's own
  auto-refresh), and a newer `auth.json` entry is never clobbered by older
  CLI creds. The stock `anthropic` provider is no longer seeded with the
  plugin's tokens (two owners of one chain = revoked grant).
- **Model visibility decoupled from the CLI**: the model catalog collapsed
  to `login + sonnet` whenever the CLI was logged out, even with a valid
  plugin-owned OAuth token in `auth.json`. The plugin now reads its own
  `auth.json` entry directly (fallback when the host's auth store lags the
  file) and uses it for both model visibility and token resolution.
- **Wire-identical meta requests**: title/summary requests to the Messages
  API now mirror the real Claude CLI — Claude Code system-prompt preamble as
  the first system block (required for OAuth-gated inference), `claude-cli`
  user-agent, `x-app: cli`, and `anthropic-dangerous-direct-browser-access`
  — so they can never be flagged as non-CLI traffic.

## 0.9.0

- **Stale rate-limit fix**: a fresh `rate_limit_event` with status `allowed`
  but no `utilization` field used to resurrect the previous window's stale
  utilization from `rate-limit.json` — after a limit window reset, normal
  chats could print a bogus "[rate-limit] Claude · five hour · 99% of window
  used · resets in …" note. Utilization is now window-scoped: only what the
  current event reports is stored, and warning notes are driven by the
  triggering event's own status/utilization (never merged history), so a
  healthy `allowed` event is always quiet
- **Conversation-history transfer**: when no Claude session can be resumed
  (first claude-code turn of a chat, switching from another provider/model
  mid-conversation, lost session store), the proxy serialized nothing and
  Claude started blind — answering "no prior context" on long-running chats.
  The prior OpenCode messages are now serialized into the prompt
  (`<conversation_history>` block, newest-first within a 400k char budget,
  tool calls/results condensed, system prompts excluded). Configurable via
  `OPENCODE_CLAUDE_HISTORY_MAX_CHARS` (`0` disables)
- **Dead resume detection**: a stored foreign session id whose Claude
  transcript file is missing (`~/.claude/projects/*/<id>.jsonl`) is dropped
  before the turn instead of producing a context-free fresh session; SDK
  "no conversation found" errors clear the stored binding so the next turn
  self-heals via history transfer
- **Stable fallback conversation key**: `conversationKeyFromMessages` hashed
  the message count into the key, so it changed on every turn and resume
  never matched when the session header was absent; the key is now stable
  across turns of the same conversation

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
