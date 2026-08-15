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

Sign each account in once:

```bash
CLAUDE_CONFIG_DIR=~/.claude-work     claude auth login
CLAUDE_CONFIG_DIR=~/.claude-personal claude auth login
```

Declare them in `opencode.json`:

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

`OPENCODE_CLAUDE_ACCOUNTS` (JSON, or `work:Work:~/.claude-work,personal:…`) and
`~/.local/share/opencode-claude/accounts.json` work too. Declare nothing and the
plugin behaves exactly as it always has — single subscription, no renames.

**Picking an account.** The model catalog gains one entry per account. The
default account keeps the bare ids (`opus`), the others are suffixed
(`opus@personal`), and every name carries its label — `Opus 5 · Personal` — so
the picker and the session header say which subscription is in play.

**Staying on it.** The first turn binds the session to that account and the
binding sticks: later turns keep the same subscription even when the request
carries no account of its own. Choosing a model from another account moves the
session and drops the resume target — the Claude transcript lives in the other
account's home and must not be resumed across accounts. Generated session
titles are prefixed with the account (`[work] Fix the proxy`), which is what
makes the binding visible in a session list; `OPENCODE_CLAUDE_ACCOUNT_TITLE_TAG=0`
turns that off.

**Seeing it.**

- `GET /v1/accounts` → every account with `authenticated`, `configDir`, its own
  rate-limit snapshot and how many sessions are bound to it.
- `GET /v1/sessions` → each conversation with the account it runs on (filter
  with `?account=work`).
- `GET /v1/rate-limit?account=work` → one account's counter; without the
  parameter you also get an `accounts` map with all of them.
- Every response carries `x-opencode-claude-account`.

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
