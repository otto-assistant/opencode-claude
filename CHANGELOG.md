# Changelog

## Unreleased

- **Multiple Claude accounts, CLI-owned end to end**: one OpenCode server can
  now drive several Claude subscriptions. Each account is a
  `CLAUDE_CONFIG_DIR` — a self-contained Claude CLI home holding its own
  credentials, transcripts and settings. The plugin never reads or writes a
  token: connecting an account means running
  `CLAUDE_CONFIG_DIR=<dir> claude auth login` (the exact command is printed by
  the panel and tools), so the CLI stays the sole owner of every credential
  chain. Accounts come from `OPENCODE_CLAUDE_ACCOUNTS` (JSON array or
  `id:label:configDir` entries) or the panel/tool-managed
  `~/.local/share/opencode-claude/accounts.json`; with neither, behaviour is
  the single-account setup, byte for byte. In multi-account mode every model
  appears once per account (`sonnet@work`, named "Claude Sonnet 4.5 (Work)"),
  requests may pin an account via the `x-opencode-claude-account` header, and
  each conversation binds to its account so follow-up turns stay put. Unknown
  account ids are rejected with 404 — never silently routed to the default
  account (and its quota).
- **Account switches never leak transcripts across logins**: a Claude-side
  resume id belongs to one account's config dir. When a conversation moves to
  a different account (model pick, header, panel/tool rebind), the stored
  resume target is cleared and the turn starts a fresh Claude session with the
  OpenCode history transferred — resuming another login's session id is never
  attempted. Removing an account reconciles all of its session bindings back
  to the default account the same way.
- **Remaining quota, without spending any**: the proxy tracks every quota
  window per account — the SDK's `rate_limit_event` reports one window at a
  time, so it is merged with the control channel's plan-usage snapshot (the
  structured data behind the CLI's `/usage` command), which reports the
  five-hour, seven-day and Opus windows at once. Refreshing quota
  (`POST /accounts/:id/quota/refresh`, panel button, or the
  `refresh-quota` tool action) boots one idle CLI probe and reads the control
  channel — no Messages API call, zero tokens spent. Probes are single-flight
  per account with a cooldown and failure backoff. Remaining percent per
  window is surfaced in the model name (` · 5h 96% 2h 20m · 7d 4% 5d`,
  disable with `OPENCODE_CLAUDE_MODEL_QUOTA=0`), `/health`, `/quota`, 429
  bodies and the control panel; a window whose reset time has passed shows
  `?` instead of a stale number.
- **Account identity from the CLI**: each account's login (email,
  organization, plan) is read over the SDK control channel and cached with a
  staleness window. The panel and `/accounts` flag two accounts that resolve
  to the same email — the duplicate-login detection from the OAuth era,
  rebuilt without the plugin ever seeing a credential.
- **Per-account usage counters**: turns and token totals (input/output/cache)
  are recorded per account per day at
  `~/.local/share/opencode-claude/usage.json` and exposed via `/usage`, the
  panel and the tools.
- **Control panel**: a self-contained HTML page (no external assets, CSP
  `default-src 'none'`) at the proxy root (`/` or `/panel`) shows accounts,
  logins, quota windows, rate-limit state, usage counters and the
  session→account map, and can add/rename/remove accounts, set the default,
  move a session and refresh quota. Mutating routes require a same-origin
  request; the panel stays loopback-only unless
  `OPENCODE_CLAUDE_PANEL_HOST` widens the bind, honours `X-Forwarded-Prefix`
  behind a reverse proxy, and `OPENCODE_CLAUDE_PANEL=0` disables the page
  (JSON API stays).
- **In-session management tools**: `claude_accounts` (list accounts with
  login, quota, usage and binding counts) and `claude_account_manage`
  (add/remove/rename/set-default/bind-session/refresh-quota) manage the
  roster from inside a session without touching the panel port. Disable with
  `OPENCODE_CLAUDE_TOOLS=0`. When accounts are configured via
  `OPENCODE_CLAUDE_ACCOUNTS`, mutations are refused with a pointer to the env
  var instead of silently writing a shadowed accounts.json.
- **Per-account rate limits**: the rate-limit store, 429 gate, `Retry-After`
  and countdown notes are all keyed by account — one exhausted subscription
  no longer blocks turns on a healthy one, and `/health?account=<id>` reports
  the account you ask about.
- **`$0 group usage limit` fails fast as a rate limit**: org spend-cap
  errors ("usage limit reached for your group", `$0 balance`) are classified
  as rate limits — 429 + gate — instead of generic 500s that hosts retry in
  a loop against a wall.
- **529 `overloaded` answered honestly**: Anthropic overload errors return
  HTTP 529 with a short `Retry-After` instead of a generic 500, and do NOT
  trip the local rate-limit gate — overload is Anthropic-side and transient,
  not a subscription window.
- **Local title/summary fallback when limited**: when the account is
  rate-limited (or the meta turn itself dies on a limit), title and summary
  requests answer 200 with a locally derived title/summary heuristic instead
  of 429 — hosts stop burning retries on meta requests that cannot succeed,
  and sessions still get a usable name. Meta requests also never bind a
  conversation to an account.
- **Smoke tests isolated from live state**: the test run redirects
  `XDG_DATA_HOME` to a temp dir and clears `OPENCODE_CLAUDE_*` overrides, so
  `bun test/smoke.ts` can never read or clobber a live rate-limit store,
  account roster or session bindings, and never binds a production port.
- **Host history transforms respected on resume**: on resumed turns the proxy
  previously ignored the host's prior messages entirely — history came from
  the Claude-side session transcript, so plugins rewriting conversation
  history via `experimental.chat.messages.transform` (e.g.
  `@tarquinen/opencode-dcp`) had no effect after turn 2. The proxy now
  fingerprints the non-system messages of every turn and, when the incoming
  array is no longer an extension of what the host sent last turn (messages
  dropped, replaced, or edited), logs a warning and rebuilds the Claude
  session from the transformed host array instead of resuming.
  `OPENCODE_CLAUDE_DIVERGENCE_REBUILD=0` downgrades this to warn-only, and
  `OPENCODE_CLAUDE_HOST_TRANSCRIPT=1` opts into full host-owned transcripts
  (never resume; rebuild from the host array every turn).
- **Meta requests no longer 400 on effort**: session title and summary
  generation force-disable thinking but still forwarded the selected effort
  (e.g. `max`), which the API rejects with
  `400 output_config.effort 'max' is not supported when thinking is disabled`.
  Effort is no longer sent for meta requests, and `startClaudeQuery` also
  drops effort defensively whenever thinking is disabled.

## 0.11.0

- **Claude CLI-owned authentication**: removed the plugin's browser OAuth
  (PKCE), credential-file parsing, token copying into OpenCode's `auth.json`,
  token refresh, and OAuth environment injection. The official Claude Code CLI
  exclusively owns and refreshes its credentials; the plugin stores no tokens
  and calls no Anthropic OAuth or inference endpoints directly.
  `CLAUDE_CODE_OAUTH_TOKEN` set by the operator (CI / headless) still passes
  through to the CLI unchanged — the plugin just never sets or rotates it.
- **Sign in without leaving the host**: the provider sign-in action relays the
  official CLI flow. `claude auth login --claudeai` runs with piped stdio, its
  authorize URL is handed to OpenCode to open, and the code from the Claude
  page is pasted in the host and written to the CLI's stdin. Success is the
  CLI's own exit status plus `claude auth status`; a rejected code keeps the
  live CLI process (and its in-memory verifier) so retries reuse the same
  challenge.
- **One-click CLI install**: a new provider action, **Install Claude Code CLI
  and sign in**, runs the official installer (`npm install -g
  @anthropic-ai/claude-code`, Anthropic's install script as fallback) when the
  CLI is missing and then continues straight into the sign-in relay. The
  method list mirrors CLI presence — only the relay when `claude` exists, only
  the install action when it does not — and `authorize` re-detects at run
  time.
- **Agent SDK-only inference**: title and summary generation now runs through
  the same Agent SDK path as normal chats, as constrained single-turn,
  tool-free queries (`maxTurns: 1`, thinking disabled, no settings/skills), so
  no direct Anthropic Messages API calls remain and agent-style output cannot
  leak into session titles.
- **Stable model catalog**: Claude models are always published — no logged-out
  placeholder catalog, and no OpenCode restart needed after signing in.
- **Turn stall watchdog**: a Claude turn that goes totally silent (dead CLI,
  wedged SDK, stuck compact) is killed after `OPENCODE_CLAUDE_TURN_STALL_MS`
  (default 10m) and answered with a truthful error instead of holding the SSE
  response open forever and wedging the session as "busy".
- **Client disconnect tears the turn down**: the SSE stream now has a
  `cancel()` handler — when OpenCode aborts the fetch mid-turn, the CLI handle
  is closed and the parked bridge dropped instead of leaking a live process.
- **SSE keep-alive**: `idleTimeout: 0` plus comment heartbeats every 5s so
  Bun's default 10s idle RST can no longer kill a response during thinking
  pauses ("Connection reset by server" retries).
- **Accurate usage for parallel tools**: each SDK assistant message ID is
  counted once per parked turn, so token usage no longer alternates between
  the real value and an inflated multiple when the SDK replays messages while
  parallel MCP tool results arrive. `prompt_tokens` now follows the OpenAI
  contract (inclusive of cache reads/writes), and per-response accumulated
  usage wins over the cumulative result snapshot of a resumed Claude query.
- **Mid-run limit handling**: a subscription limit that lands after streaming
  already began is surfaced as an OpenAI-compatible stream error that OpenCode
  treats as retryable; the retry then hits the 429 gate with the real
  `Retry-After` and reset countdown. Buffered responses preserve the true 429
  even when partial content was produced.
- **CLI resolution beyond PATH, memoized**: `claude` is looked up on PATH,
  then in `~/.local/bin` and the npm global bin (locations a managed server
  PATH misses). Resolution is cached per PATH+HOME so synchronous probes no
  longer block the host's event loop on every query; negative results stay
  uncached so a mid-process install is found on the next detect.

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
