# @otto-assistant/opencode-claude

**Claude Code inside OpenCode** — subscription auth, Claude Agent SDK harness, native effort variants, tools, skills, and streaming.

Inspired by the [OpenChamber Claude Code harness](https://github.com/makeittech/openchamber-alpha/tree/claude) and the [@otto-assistant/opencode-cursor](https://github.com/otto-assistant/opencode-cursor) plugin shape.

## Install

```bash
npm install -g @otto-assistant/opencode-claude
```

Add the plugin to `~/.config/opencode/opencode.json`:

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
npm install -g .
```

## Authenticate

### Option A — Claude Code CLI (recommended)

```bash
claude auth login
opencode auth login --provider claude-code
```

Pick **Use Claude Code CLI login**. The plugin syncs subscription OAuth from the CLI keychain / `~/.claude/.credentials.json`.

### Option B — Browser OAuth

```bash
opencode auth login --provider claude-code
```

Pick **Login with Claude Pro/Max**, open the URL, paste the redirect URL / `code#state`.

Then:

```bash
opencode run "Summarise this repository in five bullets." --model claude-code/sonnet
```

## Why this plugin

| | |
|---|---|
| **Agent SDK harness** | Runs Claude through `@anthropic-ai/claude-agent-sdk` + the local `claude` CLI — same stack as OpenChamber's Claude harness. |
| **Subscription auth** | Uses Claude Pro/Max OAuth. API keys are stripped from the child env so billing stays on the subscription. |
| **Native effort** | Model variants `low` → `max` map to Claude `--effort`. |
| **Native Claude Code** | System prompt preset, skills, project `.claude/` settings, and MCP from disk participate by default. |
| **OpenCode tools** | OpenCode tool defs are bridged as an in-process MCP server; calls park and resume like the Cursor plugin. |
| **Session resume** | Sticky foreign Claude session IDs so follow-ups resume the same Agent SDK session. |

## Architecture

```text
OpenCode
  └─ /v1/chat/completions
       └─ Bun.serve proxy
            └─ Claude Agent SDK query()
                 └─ claude CLI (subscription OAuth)
```

Model catalog mirrors the OpenChamber harness aliases (`fable`, `opus`, `sonnet`, `haiku`) plus pinned ids.

## Requirements

- [OpenCode](https://opencode.ai)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and on `PATH`
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

- `OPENCODE_CLAUDE_PROXY_PORT` — fixed local proxy port (default `8787`; must match what OpenCode resolves from static config)
- `OPENCODE_CLAUDE_CWD` — working directory passed to the Agent SDK
- `CLAUDE_CODE_OAUTH_TOKEN` — inject a subscription token (CI / headless)

## Release

Publish via GitHub Actions → **Actions → Release → Run workflow**:

| Input | Purpose |
|---|---|
| `version` | Explicit semver (`0.2.0`). Empty → use bump |
| `bump` | `minor` (default) / `patch` / `major` |
| `dry_run` | Skip npm publish; create a draft GitHub release |

Requires repo secrets: `NPM_TOKEN` (npm publish), optional `DISCORD_WEBHOOK_URL`.

The workflow: bump version → `bun test` → `bun build` → tag `vX.Y.Z` → `npm publish` → GitHub Release.

Local pin refresh after a release:

```bash
./scripts/update-plugin.sh --dry-run
./scripts/update-plugin.sh
```

## License

[MIT](LICENSE)
