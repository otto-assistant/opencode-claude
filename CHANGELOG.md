# Changelog

## Unreleased

- **Control panel at the proxy root.** A self-contained page (no external CSS,
  fonts or scripts) showing how many accounts are connected, per-account usage
  and rate-limit state, and which account every session runs on. It adds and
  removes accounts, runs Claude's browser OAuth to connect one, sets the
  default, and moves a session between accounts. The live URL is published to
  `~/.local/share/opencode-claude/endpoint.json` because the proxy binds an
  ephemeral port. Accounts added here are picked up without restarting
  OpenCode.
  - Mutating routes refuse a non-loopback `Origin`: the listener is local, but
    a page in the operator's browser could otherwise POST to it.
  - Connecting an account writes CLI-format credentials into that account's
    Claude home; from the first turn the spawned CLI owns and rotates that
    chain. The handoff is one-directional, so there is never a second owner.
- **Account changes reach the model picker without a restart.** OpenCode builds
  its provider catalog once and caches it, and the account label lives inside
  the model name — so a rename or a new account stayed invisible until the
  server restarted. There is no reload endpoint, but an empty `PATCH /config`
  makes the host re-run the plugin's config hook and rebuild the catalog;
  add, rename, remove and set-default now do that. Best effort: a host that
  will not re-read its config leaves a stale picker, which is where things
  were before, and never fails the change itself.
- **Adding an account asks for a name, nothing else.** The id is derived from
  it ("Work Shared" → `work-shared`, accents folded) and the Claude home
  follows (`~/.claude-work-shared`); a repeated name takes the next free id
  rather than erroring. Making the operator invent an id and satisfy its
  character rules was asking them to do the computer's job. An explicit id is
  still accepted, since scripts and `opencode.json` rely on it.
- **The account is session state, not a model variant.**
  `claude_account_manage {action:"use"}` switches the current session to
  another subscription without touching the model — picking `opus@personal`
  still works, but conflating "which model" with "which account" meant changing
  one forced re-picking the other. Switching to a disconnected account is
  refused rather than producing a session whose every turn 401s.
  `claude_accounts` now marks which account is current for this session, which
  is default for new ones, and which shares the ambient `~/.claude` the CLI
  itself reads.
- **Panel behind a reverse proxy.** `OPENCODE_CLAUDE_PANEL_HOST` chooses the
  bind interface (loopback still the default) and the page honours
  `X-Forwarded-Prefix`, emitting a matching `<base href>` so it works under a
  path. The automatic loopback callback is offered only to browsers that
  arrived on 127.0.0.1; through a proxy the redirect would land on the
  operator's own machine, so those logins use the paste flow.
- **Rename an account's id, not just its label.** The id appears in model ids
  (`opus@<id>`), so a slot named after the subscription it used to hold is
  misleading at the composer. Renaming migrates every per-account store —
  quota, usage, identity, rate-limit state and session bindings — since all of
  them are keyed by id.
- **Account management from inside a session.** Two tools — `claude_accounts`
  (read) and `claude_account_manage` (add / connect / rename / remove /
  disconnect / set-default / refresh-quota) — so accounts can be managed
  without reaching the panel's loopback port from whatever machine the operator
  is on. `OPENCODE_CLAUDE_TOOLS=0` removes them.
- **Panel: one-step add, and rename.** Adding an account goes straight into
  the OAuth flow instead of leaving a disconnected card behind (cancelling the
  dialog still leaves it registered). Accounts can be renamed from the card —
  the label rides into the model name, so a stale one is actively misleading
  once a Claude home is re-logged to a different subscription. The session
  list resolves labels live rather than showing the name captured at bind time.
- **Remaining quota, from Anthropic** (`GET /v1/quota`). Messages responses
  carry `anthropic-ratelimit-unified-*` headers describing both limit windows
  and naming which one is binding — a five-hour window at 56% looks fine while
  the weekly window at 93% is what actually stops the next turn, and the Agent
  SDK's `rate_limit_event` reports only one window at a time. Harvested for
  free from requests the plugin already makes (429s included), or refreshed on
  demand with a minimal Messages call; `count_tokens` is free but returns no
  such headers, so it cannot be the probe. Never polled on a timer.
  - Agent SDK `rate_limit_event`s are merged into the same store, so quota
    stays current during ordinary turns — including on hosts whose small model
    is not `claude-code`, where the meta path never runs. Merged rather than
    replaced: an event carries one window, and overwriting would erase the
    other and hide "five-hour fine, weekly nearly spent".
  - Remaining quota is surfaced *in the session*, not only in the panel: the
    in-stream rate-limit note, the 429 body when the gate blocks a turn, and
    `GET /health` all carry a `5h X% left · 7d Y% left (binding, resets in …)`
    summary.
- **Account identity, and duplicate-login detection.** Connecting an account
  resolves it against `GET /api/oauth/profile`; the panel shows the email and
  organization on the card. A browser already signed in to claude.ai approves
  the consent screen with that session and never offers an account picker, so
  connecting a "second account" can silently re-authorize the first — separate
  grants and refresh chains, one login, one quota pool. Accounts sharing an
  account uuid are flagged **same login as …**; different logins in one Team
  organization get the milder **same org as …**, since those are real separate
  seats.
  - The check runs between the token exchange and the disk write, so a
    duplicate is refused with `409 duplicate_login` and **nothing is written**.
    The exchanged tokens are held for ten minutes — an authorization code is
    single-use — so the panel can offer *Connect anyway*
    (`POST …/login/confirm`) or *Discard* without another browser round trip.
- **Per-account usage counters** (`GET /v1/usage`): turns and tokens, totals
  plus today, last 7 days and a 30-day daily series. No cost figure — these are
  subscription turns, not metered API calls.
- **Multiple Claude accounts, bound per session.** Declare several
  subscriptions (`accounts` plugin option, `OPENCODE_CLAUDE_ACCOUNTS`, or
  `accounts.json`), each backed by its own `CLAUDE_CONFIG_DIR`. The catalog
  gains one model entry per account (`opus@personal`, named `Opus 5 · Personal`),
  the first turn binds the session to the chosen account, and later turns stay
  on it. Session titles are tagged `[account]` so the binding is visible in a
  session list, and `GET /v1/accounts` / `GET /v1/sessions` expose it for
  tooling. With no accounts declared, behaviour is unchanged.
  - Credentials are read from each account's Claude home and never rotated by
    the plugin: one refresh chain, one owner (the CLI), which is the only shape
    that cannot trigger Anthropic's replay revocation.
  - A scoped account never falls back to the ambient `~/.claude`,
    `CLAUDE_CODE_OAUTH_TOKEN` or the macOS keychain — that would silently run
    the turn on the wrong subscription.
  - Rate-limit state, its 429 fast-fail gate and the stream warning dedupe are
    now per account: an exhausted subscription no longer blocks the others.
    Existing single-account stores are migrated on read.
  - Resume is account-aware: transcripts are looked up in the owning account's
    home, and moving a session to another account drops the stale resume target
    instead of resuming a foreign conversation.
- **Proxy idle timeout**: `Bun.serve` kept its 10-second default, which cut long
  Agent SDK turns (notably on a cold start). Now 255s.

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
