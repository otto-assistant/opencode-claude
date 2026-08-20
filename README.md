<p align="center">
  <img src="docs/header.svg" width="828" alt="opencode-claude — Claude Code in OpenCode, subscription OAuth, Agent SDK">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@otto-assistant/opencode-claude"><img src="https://img.shields.io/npm/v/%40otto-assistant%2Fopencode-claude?style=flat-square&color=e8a87c&labelColor=140f0c&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@otto-assistant/opencode-claude"><img src="https://img.shields.io/npm/dm/%40otto-assistant%2Fopencode-claude?style=flat-square&color=e8a87c&labelColor=140f0c" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-e8a87c?style=flat-square&labelColor=140f0c" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/linux%20·%20macos%20·%20windows-e8a87c?style=flat-square&labelColor=140f0c" alt="linux, macos, windows">
  <a href="https://github.com/otto-assistant/opencode-claude/releases"><img src="https://img.shields.io/github/v/release/otto-assistant/opencode-claude?style=flat-square&color=e8a87c&labelColor=140f0c&label=release" alt="latest release"></a>
</p>

<p align="center">
  <strong>Claude Code inside OpenCode</strong> — Pro/Max subscription OAuth,<br>
  Agent SDK harness, effort variants, tools, images, and compact.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#authenticate">Authenticate</a> ·
  <a href="#why-this-plugin">Why this plugin</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

Run Claude Code from your Claude Pro/Max subscription inside OpenCode: Fable, Opus, Sonnet, Haiku — with thinking effort `low`→`max`, streaming, OpenCode tool calls that park and resume, MCP, image/PDF attachments, and auto-compact.

Uses the same Agent SDK + `claude` CLI stack as the [OpenChamber Claude harness](https://github.com/makeittech/openchamber-alpha/tree/claude). Plugin shape mirrors [@otto-assistant/opencode-cursor](https://github.com/otto-assistant/opencode-cursor).

## Install

`claude-code` is **not** a built-in OpenCode provider. Install the plugin first, or
`opencode auth login --provider claude-code` fails with `Unknown provider "claude-code"`.

```bash
# global (recommended)
opencode plugin @otto-assistant/opencode-claude -g

# or project-local (writes .opencode/opencode.json)
opencode plugin @otto-assistant/opencode-claude
```

Optional provider naming (also seeded when the plugin loads):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@otto-assistant/opencode-claude"],
  "provider": {
    "claude-code": { "name": "Claude Code" }
  }
}
```

Or build from source:

```bash
git clone https://github.com/otto-assistant/opencode-claude.git
cd opencode-claude
bun install && bun run build
opencode plugin file://$PWD
```

## Authenticate

Requires the plugin to be installed (see above).

```bash
# Option A — sync from Claude Code CLI (recommended)
claude auth login
opencode auth login --provider claude-code
# pick "Use Claude Code CLI login"

# Option B — browser OAuth (Pro/Max)
opencode auth login --provider claude-code
# pick "Login with Claude Pro/Max"
```

Then start OpenCode, pick provider **claude-code**, choose a model, and set the
**effort** variant (`low` / `medium` / `high` / `xhigh` / `max`) when you want
deeper thinking.

```bash
opencode run "Summarise this repository in five bullets." --model claude-code/sonnet
```

## Why this plugin

| | |
|---|---|
| **Agent SDK harness** | Runs Claude through `@anthropic-ai/claude-agent-sdk` + the local `claude` CLI — same stack as OpenChamber. |
| **Subscription auth** | Claude Pro/Max OAuth (CLI sync or browser). API keys are stripped from the child env so billing stays on the subscription. |
| **Effort / thinking** | Native OpenCode variants `low`→`max` map to Claude `--effort` + adaptive thinking. |
| **Agent-grade tools** | OpenCode tools bridge as in-process MCP; calls park and resume instead of deadlocking or inventing output. |
| **Attachments** | Images and PDFs from OpenCode reach Claude (data URLs + remote URLs). |
| **Auto-compact** | Long sessions compact like Claude Code; boundary events are surfaced in the stream. |
| **Session resume** | Sticky foreign Claude session IDs so follow-ups continue the same Agent SDK turn. |
| **History transfer** | When no Claude session can be resumed (first claude-code turn of a chat, model switch mid-conversation, pruned transcript), the full prior conversation is serialized into the prompt — Claude never starts blind. |
| **Rate-limit counter** | Subscription limit state is tracked with its reset time; `GET /v1/rate-limit` answers "when are limits back", and doomed turns fail fast with 429 + `Retry-After`. |

## Architecture

```text
OpenCode
  └─ /v1/chat/completions
       └─ Bun.serve proxy (ephemeral port; published via auth loader)
            └─ Claude Agent SDK query()
                 └─ claude CLI (subscription OAuth)
```

Model catalog: aliases `fable` / `opus` / `sonnet` / `haiku` plus pinned ids.
Effort selection is encoded in `x-opencode-claude-effort` so the proxy passes the
exact `effort` (+ adaptive thinking) into the Agent SDK.

### Multiple Claude accounts

One OpenCode server can drive several Claude subscriptions at once, with each
session pinned to one of them: this chat runs on `work`, that one on
`personal`. Each account is a `CLAUDE_CONFIG_DIR` — a self-contained Claude CLI
home with its own credentials, transcripts and settings.

#### The panel

The proxy serves a control panel at its root. It shows how many accounts are
connected, what each one has been used for, and which account every session is
running on — and it connects new accounts without a config file or a terminal.

```bash
open "$(jq -r .panel ~/.local/share/opencode-claude/endpoint.json)"
```

The proxy binds an ephemeral port, so the live URL is published to
`endpoint.json` on every start and logged at startup. Pin it with
`OPENCODE_CLAUDE_PROXY_PORT` if you would rather bookmark it.

**Behind a reverse proxy.** `OPENCODE_CLAUDE_PANEL_HOST=0.0.0.0` binds the
listener where a proxy can reach it — the panel manages subscription
credentials, so it is loopback-only until you say otherwise, and it is then
only as protected as the proxy in front. The page honours `X-Forwarded-Prefix`
(it emits a matching `<base href>`), so serving it under a path works; give
Traefik a StripPrefix plus a redirect to the trailing slash the base tag needs.

One consequence: the automatic loopback callback is offered **only** to a
browser that reached the panel on 127.0.0.1. Through a proxy the redirect would
land on the operator's own machine, so those logins fall back to pasting the
redirect URL — the plugin decides per request from the `Host` header.

From the panel you can **add and connect** an account in one step — you give it
a name, the id and Claude home are derived from it ("Work Shared" →
`work-shared`, `~/.claude-work-shared`, models `opus@work-shared`), and the form
goes straight into Claude's browser OAuth, **rename**, **disconnect**, make one the
**default**, **remove**, and **move a session** to another account. Everything
it does is also available as JSON; see the endpoints below.

There is no way to connect several accounts at once: each is its own
authorization code and its own grant, so each needs one approval in the
browser. What the panel removes is the bookkeeping around it.

**The first account.** Whatever is already signed in via `claude auth login`
is adopted as the implicit default, so an existing setup needs no migration.
On a clean machine the panel shows that implicit account as *not connected*
with a Connect button, and signing in from there writes to the ambient Claude
home — either route works.

Accounts added from the panel are stored in
`~/.local/share/opencode-claude/accounts.json` and picked up live, without
restarting OpenCode.

#### From inside a session

The panel is a page on a loopback port, which is fine for looking and awkward
for doing — an operator on another machine has to tunnel to it just to add an
account. So the plugin also registers two tools:

- `claude_accounts` — every subscription: connected or not, which login it is,
  its organization and role, quota left, usage, sessions bound, and a warning
  when two entries are the same login.
- `claude_account_manage` — `add`, `connect`, `rename`, `remove`,
  `disconnect`, `set-default`, `refresh-quota`. Adding returns the sign-in URL.

So "which Claude accounts do I have" or "add an account called client" works
from the chat, with no second UI to reach. `OPENCODE_CLAUDE_TOOLS=0` removes
them.

#### Declaring accounts up front

The panel is not required. Sign each account in from a terminal:

```bash
CLAUDE_CONFIG_DIR=~/.claude-work     claude auth login
CLAUDE_CONFIG_DIR=~/.claude-personal claude auth login
```

and declare them in `opencode.json`:

```json
{
  "plugin": [
    ["@otto-assistant/opencode-claude", {
      "accounts": [
        { "id": "work", "label": "Work", "configDir": "~/.claude-work", "default": true },
        { "id": "personal", "label": "Personal", "configDir": "~/.claude-personal" }
      ]
    }]
  ]
}
```

`OPENCODE_CLAUDE_ACCOUNTS` (JSON, or `work:Work:~/.claude-work,personal:…`)
works too. Declared accounts and panel-added ones merge, the file winning on id
conflicts. Declare nothing and the plugin behaves exactly as it always has —
single subscription, no renames, no panel-driven changes to your setup.

**Picking an account.** Each account gets **its own provider** —
`Claude Code · Work`, `Claude Code · Personal` — because the host groups the
model picker by provider. Four accounts become four labelled groups of six
rather than one flat list of twenty-four rows each repeating the account name.
The default account keeps the bare `claude-code` provider id, so nothing
renames for single-account installs.

The `model@account` form still resolves, for anything pinned before this. The
old flat catalog described below applies when a single provider is in play:
the default account keeps the bare ids (`opus`), the others are suffixed
(`opus@personal`), and every name carries its label — `Opus 5 · Personal` — so
the picker and the session header say which subscription is in play.

**The account is session state.** Picking `opus@personal` sets it, but so does
`claude_account_manage {action: "use", id: "personal"}` — and that second form
is usually what you want, because it separates *which subscription* from *which
model*. A bare model id (`opus`) carries no account, so the session simply stays
on whatever it is bound to; you change model and account independently instead
of re-picking a suffixed model every time.

`claude_accounts` marks, for each account: which one is CURRENT for this
session, which is the default for new sessions, and which one shares the
ambient `~/.claude` that a bare `claude` in a terminal also uses.

**Staying on it.** The first turn binds the session to that account and the
binding sticks: later turns keep the same subscription even when the request
carries no account of its own. Choosing a model from another account moves the
session and drops the resume target — the Claude transcript lives in the other
account's home and must not be resumed across accounts. Generated session
titles are prefixed with the account (`[work] Fix the proxy`), which is what
makes the binding visible in a session list; `OPENCODE_CLAUDE_ACCOUNT_TITLE_TAG=0`
turns that off.

**Which login is it, really.** Connecting an account resolves it against
`GET /api/oauth/profile` and the panel shows the email and organization on the
card. This is not decoration: a browser already signed in to claude.ai approves
the consent screen with *that* session and never offers an account picker, so
"connect a second account" silently re-authorizes the first one — different
OAuth grants, different refresh chains, everything looks like two accounts, and
it is one login sharing one quota pool. So the check runs **between the token exchange and the disk write** — the only
point at which refusing costs nothing. A login that resolves to an account
already connected here is rejected with `409 duplicate_login`, and **no
credentials are written**. The exchanged tokens are held in memory for ten
minutes (an authorization code is single-use, so discarding them would force a
whole new round trip just to confirm), and the panel offers two buttons:
*Connect anyway* — `POST /v1/accounts/:id/login/confirm` — or *Discard*.

Already-connected accounts resolving to the same account uuid are flagged
**same login as …**; two different logins in one Team organization get the
milder **same org as …**, since those are genuinely separate seats. To connect
a different account, sign out of claude.ai first or use a private window.

**What a token can and cannot tell you.** Each connected account reports its
email, organization (name, type, rate-limit tier, subscription status), the
plan on the account, and **this account's role** in its org and workspace —
from `GET /api/oauth/profile` and `/api/oauth/claude_cli/roles`.

It cannot list the *other members* of an organization. Those endpoints exist
(`/api/organizations/<uuid>/members`) but reject a Claude Code OAuth token with
`account_session_invalid`: they want a claude.ai account session, which is a
browser cookie, not an OAuth grant. The plugin can only describe the tokens it
holds — so to see or use a colleague's seat, that person signs in as their own
account here.

**Seeing it.**

- `GET /` → the panel.
- `GET /v1/accounts` → every account with `authenticated`, `configDir`, its own
  rate-limit snapshot, usage counters and how many sessions are bound to it.
- `GET /v1/usage` → per-account turns and tokens: totals, today, last 7 days,
  and a daily series (30 days retained). Subscription turns are not metered
  API calls, so no cost figure is reported.
- `GET /v1/quota` → how much of each subscription is **left**, straight from
  Anthropic (see below).
- Each account in `GET /v1/accounts` carries `identity` (email, organization)
  plus `sharesLoginWith` / `sharesOrganizationWith`.
- `GET /v1/sessions` → each conversation with the account it runs on (filter
  with `?account=work`).
- `GET /v1/rate-limit?account=work` → one account's counter; without the
  parameter you also get an `accounts` map with all of them.
- Every response carries `x-opencode-claude-account`.

**Changing it.** `POST /v1/accounts` (add), `DELETE /v1/accounts/:id`,
`POST /v1/accounts/:id/default`, `POST /v1/accounts/:id/login/start` →
`.../login/complete` (browser OAuth), `POST /v1/accounts/:id/disconnect`, and
`POST /v1/sessions/:key/account` to move a session.

The listener is bound to `127.0.0.1`, and mutating routes additionally refuse
any request carrying a non-loopback `Origin` — otherwise a page open in the
same browser could add accounts or start an OAuth flow against your local
proxy. Reads are not gated.

**Why config dirs and not N token sets held by the plugin.** Anthropic rotates
the refresh token on every use, and a chain with two owners gets the whole grant
revoked for replay. Giving each account its own CLI home keeps exactly one owner
per chain — the CLI — so accounts cannot race each other's rotation. The plugin
reads those credentials, never rotates them; when an account's token is stale it
spawns the CLI without `CLAUDE_CODE_OAUTH_TOKEN` and lets the CLI refresh itself.

Rate limits are tracked per account, so an exhausted subscription no longer
gates turns running on another one.

> `CLAUDE_CONFIG_DIR` also relocates settings, skills and the user-level
> `CLAUDE.md`. Symlink whatever you want shared into each account's home.

### How much quota is left

Every Anthropic Messages response carries unified rate-limit headers describing
**both** limit windows at once:

```
anthropic-ratelimit-unified-5h-utilization: 0.56
anthropic-ratelimit-unified-5h-reset: 1786797000
anthropic-ratelimit-unified-7d-utilization: 0.93
anthropic-ratelimit-unified-7d-status: allowed_warning
anthropic-ratelimit-unified-representative-claim: seven_day
```

That last header names the window actually gating you. It matters: a five-hour
window at 56% looks healthy while the weekly window at 93% is what will stop
the next turn. The Agent SDK's `rate_limit_event` reports one window at a time,
so it cannot tell you this on its own.

The plugin gets those numbers two ways:

- **Free.** It harvests the headers from requests it already makes (the
  title/summary path), including failed ones — a 429 carries them too, and
  that is exactly when they matter.
- **On demand.** `POST /v1/accounts/:id/quota/refresh`, or **Check quota** in
  the panel, sends the smallest possible real Messages call (~20 input tokens).
  `count_tokens` would be free but returns no rate-limit headers, so it cannot
  serve as the probe. Nothing calls this on a timer — spending quota to measure
  quota is a bad trade, and the panel's auto-refresh only re-renders what is
  already cached.

The panel shows each window as *percent left* with a reset countdown, marks the
binding one, and colours it amber under 25% and red under 10%.

**Inside the session, not only in the panel.** Ordinary turns emit Agent SDK
`rate_limit_event`s, and each one is merged into the stored quota — merged, not
replaced, since an event carries a single window and overwriting would erase
the other one. So the numbers stay fresh for free even on hosts whose small
model is not `claude-code` (where the meta path never runs). When the limiter
warns, the in-stream note now says what is left across both windows:

```
[rate-limit] Claude seven day · 93% of window used · 5h 43% left · 7d 7% left (binding, resets in 2d 18h)
```

The same summary is appended to the 429 body when the fast-fail gate blocks a
turn — the moment you most want it — and to `GET /health`.

### Rate-limit counter

The proxy records Agent SDK `rate_limit_event` telemetry and hard session-limit
errors (including the parsed reset time) to
`~/.local/share/opencode-claude/rate-limit.json`.

- `GET /v1/rate-limit` → `{ limited, status, rateLimitType, utilization, resetsAt, resetsAtISO, resetInSeconds, message, updatedAt }` — poll this for a "limits reset in …" countdown. `utilization` is only present when the latest SDK event reported it — it is never carried over from an earlier limit window, so a freshly reset window never shows a stale percentage.
- `GET /health` includes a compact `rateLimit` summary.
- While a confirmed hard limit is active, new chat turns return HTTP **429**
  with `Retry-After` + `x-claude-rate-limit-reset` headers and an
  `error.type = "rate_limit_error"` body (title/summary meta requests are never
  gated). The block lifts automatically at reset time; the next turn then
  resumes the same Claude session (sticky session store is untouched).
- `OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL=0` disables the 429 gate (turns are
  attempted and error normally).

## Requirements

- [OpenCode](https://opencode.ai)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) on `PATH`
- Claude Pro/Max subscription (or CLI OAuth credentials)
- Bun (plugin runtime) · Node.js ≥ 18

## Development

```bash
bun install
bun run build
bun run test
```

Debug logging: `OPENCODE_CLAUDE_DEBUG=1`.

Optional knobs:

- `OPENCODE_CLAUDE_PROXY_PORT` — optional pinned proxy port (default: ephemeral / OS-assigned; live URL is published to OpenCode via config + auth loader)
- `OPENCODE_CLAUDE_CWD` — working directory passed to the Agent SDK
- `CLAUDE_CODE_OAUTH_TOKEN` — inject a subscription token (CI / headless)
- `OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL` — `0` disables the 429 rate-limit gate
- `OPENCODE_CLAUDE_RATE_LIMIT_STORE` — override the rate-limit store path (tests)
- `OPENCODE_CLAUDE_HISTORY_MAX_CHARS` — budget for transferred conversation history when a Claude session cannot be resumed (default `400000`; newest messages are kept, `0` disables transfer)

## Release

Publish via GitHub Actions → **Actions → Release → Run workflow**:

| Input | Purpose |
|---|---|
| `version` | Explicit semver (`0.6.0`). Empty → use bump |
| `bump` | `minor` (default) / `patch` / `major` |
| `dry_run` | Skip npm publish; create a draft GitHub release |

Requires repo secrets: `NPM_TOKEN`, optional `DISCORD_WEBHOOK_URL`.

Local pin refresh after a release:

```bash
./scripts/update-plugin.sh --dry-run
./scripts/update-plugin.sh
```

## License

[MIT](LICENSE)
