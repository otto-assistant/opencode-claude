/**
 * Multi-account registry for Claude Code subscriptions.
 *
 * One OpenCode server can drive several Claude subscriptions at once, with a
 * per-session binding: session A runs on the "work" account, session B on
 * "personal". Each account is a `CLAUDE_CONFIG_DIR` — a self-contained Claude
 * CLI home holding its own `.credentials.json`, transcripts and settings.
 *
 * Why config dirs instead of N token sets held by this plugin: Anthropic
 * rotates the refresh token on every use, and a chain with two owners gets the
 * WHOLE grant revoked for replay (see auth-login.ts). Handing each account its
 * own CLI home keeps exactly one owner per chain — the CLI — so no rotation
 * race can exist between accounts.
 *
 * Resolution order (first non-empty wins):
 * 1. Plugin options in opencode.json: `["…/opencode-claude", { accounts: […] }]`
 * 2. `OPENCODE_CLAUDE_ACCOUNTS` — JSON array, or `id:label:configDir` entries
 *    separated by commas.
 * 3. `$XDG_DATA_HOME/opencode-claude/accounts.json`
 * 4. Nothing configured → a single implicit account using the ambient Claude
 *    home. This is the pre-multi-account behaviour, byte for byte.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { log } from "./log.js";

export type ClaudeAccount = {
  /** Slug used in model ids, store keys and headers. */
  id: string;
  /** Human label shown in the model picker and session titles. */
  label: string;
  /**
   * CLAUDE_CONFIG_DIR for this account. Undefined means the ambient Claude
   * home (`~/.claude` or an inherited CLAUDE_CONFIG_DIR) — at most one account
   * may leave it undefined.
   */
  configDir?: string;
  /** Account used when a request carries no account of its own. */
  isDefault: boolean;
};

/** Id of the implicit single account — never appears in the UI. */
export const AMBIENT_ACCOUNT_ID = "default";

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

let accounts: ClaudeAccount[] | null = null;

function ambientAccount(): ClaudeAccount {
  return { id: AMBIENT_ACCOUNT_ID, label: "Claude Code", isDefault: true };
}

function expandHome(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

function accountsFilePath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "accounts.json");
}

function parseAccountEntry(raw: unknown): ClaudeAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const id = typeof entry.id === "string" ? entry.id.trim().toLowerCase() : "";
  if (!ACCOUNT_ID_PATTERN.test(id)) {
    log.warn("[opencode-claude] ignoring account with invalid id", { id });
    return null;
  }
  const configDirRaw =
    typeof entry.configDir === "string"
      ? entry.configDir
      : typeof entry.claudeConfigDir === "string"
        ? entry.claudeConfigDir
        : "";
  const configDir = configDirRaw ? expandHome(configDirRaw) : undefined;
  if (configDir && !isAbsolute(configDir)) {
    log.warn("[opencode-claude] ignoring account with relative configDir", {
      id,
      configDir,
    });
    return null;
  }
  const label =
    typeof entry.label === "string" && entry.label.trim()
      ? entry.label.trim()
      : id;
  return {
    id,
    label,
    ...(configDir ? { configDir } : {}),
    isDefault: entry.default === true || entry.isDefault === true,
  };
}

/**
 * Drop invalid entries and guarantee exactly one default. Two accounts sharing
 * a config dir (or both inheriting the ambient one) would silently be the same
 * subscription wearing two labels, so the duplicate is dropped.
 */
function normalize(entries: ClaudeAccount[]): ClaudeAccount[] {
  const byId = new Map<string, ClaudeAccount>();
  const seenDirs = new Set<string>();
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      log.warn("[opencode-claude] duplicate account id ignored", { id: entry.id });
      continue;
    }
    const dirKey = entry.configDir ?? "<ambient>";
    if (seenDirs.has(dirKey)) {
      log.warn("[opencode-claude] account ignored: config dir already claimed", {
        id: entry.id,
        configDir: dirKey,
      });
      continue;
    }
    seenDirs.add(dirKey);
    byId.set(entry.id, entry);
  }
  const list = [...byId.values()];
  if (list.length === 0) return [ambientAccount()];
  const defaults = list.filter((a) => a.isDefault);
  if (defaults.length !== 1) {
    // No explicit default (or several): the first entry wins, deterministically.
    for (const account of list) account.isDefault = false;
    list[0].isDefault = true;
    if (defaults.length > 1) {
      log.warn("[opencode-claude] several accounts marked default; using the first", {
        chosen: list[0].id,
      });
    }
  }
  return list;
}

function fromEnv(): ClaudeAccount[] | null {
  const raw = process.env.OPENCODE_CLAUDE_ACCOUNTS?.trim();
  if (!raw) return null;
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      const list = parsed
        .map(parseAccountEntry)
        .filter((a): a is ClaudeAccount => a !== null);
      return list.length > 0 ? list : null;
    } catch (err) {
      log.warn("[opencode-claude] OPENCODE_CLAUDE_ACCOUNTS is not valid JSON", {
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
  // Shorthand: "work:Work:~/.claude-work,personal:Personal:~/.claude-personal"
  const list = raw
    .split(",")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk, index) => {
      const [id, label, configDir] = chunk.split(":").map((p) => p.trim());
      return parseAccountEntry({
        id,
        label: label || id,
        configDir,
        default: index === 0,
      });
    })
    .filter((a): a is ClaudeAccount => a !== null);
  return list.length > 0 ? list : null;
}

function fromFile(): ClaudeAccount[] | null {
  const path = accountsFilePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const raw = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { accounts?: unknown })?.accounts)
        ? (parsed as { accounts: unknown[] }).accounts
        : null;
    if (!raw) return null;
    const list = raw
      .map(parseAccountEntry)
      .filter((a): a is ClaudeAccount => a !== null);
    return list.length > 0 ? list : null;
  } catch (err) {
    log.warn("[opencode-claude] accounts.json unreadable; ignoring", {
      path,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Seed the registry from plugin options. Called once from the plugin factory;
 * passing nothing leaves env/file/ambient resolution in charge.
 */
export function configureAccounts(raw: unknown): ClaudeAccount[] {
  const list = Array.isArray(raw)
    ? raw.map(parseAccountEntry).filter((a): a is ClaudeAccount => a !== null)
    : [];
  accounts = list.length > 0 ? normalize(list) : normalize(fromEnv() ?? fromFile() ?? []);
  if (accounts.length > 1) {
    log.info("[opencode-claude] multi-account mode", {
      accounts: accounts.map((a) => `${a.id}${a.isDefault ? "*" : ""}`),
    });
  }
  return accounts;
}

/** Test helper: forget the resolved registry so the next read re-resolves. */
export function resetAccounts(): void {
  accounts = null;
}

export function getAccounts(): ClaudeAccount[] {
  if (!accounts) accounts = normalize(fromEnv() ?? fromFile() ?? []);
  return accounts;
}

export function getDefaultAccount(): ClaudeAccount {
  const list = getAccounts();
  return list.find((a) => a.isDefault) ?? list[0];
}

/** True once the operator configured more than one subscription. */
export function isMultiAccount(): boolean {
  return getAccounts().length > 1;
}

/** Look up by id; unknown ids fall back to the default account. */
export function resolveAccount(id: string | null | undefined): ClaudeAccount {
  if (!id) return getDefaultAccount();
  const wanted = id.trim().toLowerCase();
  if (!wanted) return getDefaultAccount();
  const match = getAccounts().find((a) => a.id === wanted);
  if (match) return match;
  log.warn("[opencode-claude] unknown account id; using default", { id: wanted });
  return getDefaultAccount();
}

export function findAccount(id: string | null | undefined): ClaudeAccount | null {
  if (!id) return null;
  const wanted = id.trim().toLowerCase();
  return getAccounts().find((a) => a.id === wanted) ?? null;
}

/**
 * Claude home for an account. Falls back to the ambient CLAUDE_CONFIG_DIR (or
 * `~/.claude`) so single-account setups keep reading exactly what they did.
 */
export function accountConfigDir(account: ClaudeAccount): string {
  if (account.configDir) return account.configDir;
  const ambient = process.env.CLAUDE_CONFIG_DIR?.trim();
  return ambient || join(homedir(), ".claude");
}

/**
 * Child env pointing the Claude CLI at this account's home. Accounts without
 * an explicit config dir inherit the parent env untouched.
 */
export function applyAccountEnv(
  account: ClaudeAccount,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (!account.configDir) return env;
  return { ...env, CLAUDE_CONFIG_DIR: account.configDir };
}

/**
 * Short tag for logs, titles and store keys. Empty in single-account mode so
 * nothing in the UI changes for operators who never configured accounts.
 */
export function accountTag(account: ClaudeAccount): string {
  return isMultiAccount() ? account.id : "";
}

/** Namespace a per-account store key, transparent in single-account mode. */
export function accountScopedKey(account: ClaudeAccount, key: string): string {
  const tag = accountTag(account);
  return tag ? `${tag}::${key}` : key;
}
