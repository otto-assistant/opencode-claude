/**
 * Multi-account registry for Claude Code subscriptions — CLI-owned auth.
 *
 * One OpenCode server can drive several Claude subscriptions at once, with a
 * per-session binding: session A runs on the "work" account, session B on
 * "personal". Each account is a `CLAUDE_CONFIG_DIR` — a self-contained Claude
 * CLI home holding its own credentials, transcripts and settings.
 *
 * The plugin NEVER reads or writes credentials: signing an account in is
 * `CLAUDE_CONFIG_DIR=<dir> claude auth login`, run by the operator. The
 * plugin only points the spawned CLI at the right home, so exactly one owner
 * (the CLI) holds each refresh-token chain and no rotation race can exist.
 *
 * Resolution order (first non-empty wins):
 * 1. `OPENCODE_CLAUDE_ACCOUNTS` — JSON array, or `id:label:configDir` entries
 *    separated by commas.
 * 2. `$XDG_DATA_HOME/opencode-claude/accounts.json` (panel/tool-managed)
 * 3. Nothing configured → a single implicit account using the ambient Claude
 *    home. This is the single-account behaviour, byte for byte.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { log } from "./log.js";
import { countBoundSessions } from "./session-store.js";

export type ClaudeAccount = {
  /** Slug used in model ids, store keys and headers. */
  id: string;
  /** Human label shown in the model picker and panel. */
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
/** mtime of accounts.json the cache was built from, so panel edits land live. */
let accountsFileStamp = 0;

function accountsFileMtime(): number {
  try {
    return statSync(accountsFilePath()).mtimeMs;
  } catch {
    return 0;
  }
}

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
 * subscription wearing two labels — the CLI-profile flavour of a duplicate
 * login — so the duplicate is dropped with a warning.
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

type FileRoster =
  | { status: "absent" }
  | { status: "valid"; accounts: ClaudeAccount[] }
  | { status: "invalid" };

function fromFile(): FileRoster {
  const path = accountsFilePath();
  if (!existsSync(path)) return { status: "absent" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    log.warn("[opencode-claude] accounts.json unreadable; ignoring", {
      path,
      message: err instanceof Error ? err.message : String(err),
    });
    return { status: "invalid" };
  }
  try {
    const parsed = JSON.parse(text);
    const raw = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { accounts?: unknown })?.accounts)
        ? (parsed as { accounts: unknown[] }).accounts
        : null;
    if (!raw) {
      log.warn("[opencode-claude] accounts.json has an invalid roster shape", { path });
      return { status: "invalid" };
    }
    const list = raw
      .map(parseAccountEntry)
      .filter((a): a is ClaudeAccount => a !== null);
    return { status: "valid", accounts: list };
  } catch (err) {
    log.warn("[opencode-claude] accounts.json is not valid JSON", {
      path,
      message: err instanceof Error ? err.message : String(err),
    });
    return { status: "invalid" };
  }
}

/**
 * Environment configuration is an explicit deployment choice and wins whole;
 * otherwise the managed file is the complete roster (an account absent from
 * it was deliberately removed). A present-but-malformed file fails closed to
 * the ambient account instead of resurrecting removed entries.
 */
function resolveRegistry(): ClaudeAccount[] {
  const fromEnvironment = fromEnv();
  const fileRoster = fromFile();
  const list =
    fromEnvironment ??
    (fileRoster.status === "valid" ? fileRoster.accounts : []);
  accountsFileStamp = accountsFileMtime();
  return normalize(list);
}

/** Test helper: forget the resolved registry so the next read re-resolves. */
export function resetAccounts(): void {
  accounts = null;
  accountsFileStamp = 0;
}

export function getAccounts(): ClaudeAccount[] {
  // Re-resolve when the panel/tools rewrote accounts.json, so a newly added
  // account is usable without restarting the OpenCode server.
  if (!accounts || accountsFileMtime() !== accountsFileStamp) {
    accounts = resolveRegistry();
  }
  return accounts;
}

/** Path of the managed registry — surfaced in the UI for transparency. */
export function getAccountsFilePath(): string {
  return accountsFilePath();
}

function persistAccounts(list: ClaudeAccount[]): void {
  const path = accountsFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        accounts: list.map((a) => ({
          id: a.id,
          label: a.label,
          ...(a.configDir ? { configDir: a.configDir } : {}),
          default: a.isDefault,
        })),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  accounts = null; // force a re-resolve on next read
}

/**
 * Turn a human label into an account id: "Work Shared" → "work-shared".
 * Accents are folded rather than dropped so "Cuenta Diseño" stays legible
 * as "cuenta-diseno".
 */
export function slugifyAccountId(label: string): string {
  const base = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return /^[a-z0-9]/.test(base) ? base : `account-${base}`.slice(0, 32);
}

/** First free id in the `base`, `base-2`, `base-3`… series. */
function uniqueAccountId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 29)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new AccountError("could not derive a free account id");
}

/** The email address written inside a label, if there is one. */
export function labelEmail(label: string): string | null {
  const match = /[^\s<>()[\],;:"]+@[^\s<>()[\],;:"]+\.[a-z]{2,}/i.exec(label || "");
  return match ? match[0] : null;
}

/**
 * A label must not name a login. The label is a string an operator types
 * once; the login is resolved from the CLI (accountInfo) and can turn out to
 * be — or become — somebody else. When they disagree the account card
 * contradicts itself, and the half a human reads first is the label.
 */
export function assertLabelNamesNoLogin(label: string): void {
  const email = labelEmail(label);
  if (!email) return;
  throw new AccountError(
    `a label must not contain an email address (${email}) — the login is resolved ` +
      `from the CLI and shown on its own line, so a hand-written one only ` +
      `gets a chance to be wrong. Name the slot for its role instead, e.g. "Work".`,
  );
}

export class AccountError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AccountError";
    this.status = status;
  }
}

/**
 * Registry mutations edit accounts.json — but OPENCODE_CLAUDE_ACCOUNTS wins
 * whole over the file, so a mutation made while the env override is active
 * would write state nobody ever reads. Refuse loudly instead.
 */
function assertRegistryMutable(): void {
  if (process.env.OPENCODE_CLAUDE_ACCOUNTS?.trim()) {
    throw new AccountError(
      "accounts are configured via OPENCODE_CLAUDE_ACCOUNTS — edit that " +
        "environment variable instead; registry changes made here would be ignored",
      409,
    );
  }
}

/**
 * Register an account. The config dir is created on demand so the operator's
 * `CLAUDE_CONFIG_DIR=<dir> claude auth login` has somewhere to write.
 */
export function addAccount(input: {
  id?: unknown;
  label?: unknown;
  configDir?: unknown;
  makeDefault?: boolean;
}): ClaudeAccount {
  assertRegistryMutable();
  const existing = getAccounts();
  const taken = new Set(existing.map((a) => a.id));
  const givenId = typeof input.id === "string" ? input.id.trim().toLowerCase() : "";
  const givenLabel =
    typeof input.label === "string" && input.label.trim() ? input.label.trim() : "";

  // An explicit id still wins — scripts rely on it — but the normal path is
  // to name the account and let the id follow.
  let id: string;
  if (givenId) {
    if (!ACCOUNT_ID_PATTERN.test(givenId)) {
      throw new AccountError(
        "id must be lowercase letters, digits, dot, dash or underscore (max 32 chars)",
      );
    }
    if (taken.has(givenId)) {
      throw new AccountError(`account "${givenId}" already exists`, 409);
    }
    id = givenId;
  } else {
    if (!givenLabel) throw new AccountError("give the account a name");
    const slug = slugifyAccountId(givenLabel);
    if (!ACCOUNT_ID_PATTERN.test(slug)) {
      throw new AccountError(
        `could not derive an id from "${givenLabel}" — give one explicitly`,
      );
    }
    id = uniqueAccountId(slug, taken);
  }
  const label = givenLabel || id;
  assertLabelNamesNoLogin(label);
  const rawDir =
    typeof input.configDir === "string" && input.configDir.trim()
      ? input.configDir
      : `~/.claude-${id}`;
  const configDir = expandHome(rawDir);
  if (!isAbsolute(configDir)) {
    throw new AccountError("configDir must be an absolute path (or start with ~)");
  }
  if (existing.some((a) => accountConfigDir(a) === configDir)) {
    throw new AccountError(
      `another account already uses ${configDir} — one Claude home per account`,
      409,
    );
  }
  mkdirSync(configDir, { recursive: true, mode: 0o700 });

  // The pre-existing single account is implicit; persisting it alongside the
  // new one keeps the ambient Claude home addressable instead of vanishing
  // behind the first account somebody adds.
  const baseline = existing.map((account) =>
    account.id === AMBIENT_ACCOUNT_ID && !account.configDir
      ? { ...account, configDir: accountConfigDir(account) }
      : account,
  );
  const created: ClaudeAccount = {
    id,
    label,
    configDir,
    isDefault: false,
  };
  const next = [...baseline, created];
  if (input.makeDefault) {
    for (const account of next) account.isDefault = account.id === id;
  }
  persistAccounts(normalize(next));
  log.info("[opencode-claude] account added", { id, configDir });
  return created;
}

/** Forget an account. Its Claude home is left on disk — credentials are the operator's. */
export function removeAccount(id: string, force = false): void {
  assertRegistryMutable();
  const wanted = id.trim().toLowerCase();
  const existing = getAccounts();
  const target = existing.find((a) => a.id === wanted);
  if (!target) throw new AccountError(`unknown account "${wanted}"`, 404);
  if (existing.length === 1) {
    throw new AccountError("cannot remove the only account", 409);
  }
  // Conversations bound to this account do not disappear with it. They get
  // swept onto the default account and lose the transcript that lived in
  // this account's Claude home. Removing an account with live conversations
  // is therefore a decision about THOSE conversations — make it deliberate.
  const bound = countBoundSessions(wanted);
  if (bound > 0 && !force) {
    throw new AccountError(
      `"${wanted}" still owns ${bound} conversation${bound === 1 ? "" : "s"}. ` +
        `Removing it moves them to the default account and loses their Claude ` +
        `transcript. Move them first, or pass force to accept that.`,
      409,
    );
  }
  const next = existing.filter((a) => a.id !== wanted);
  if (target.isDefault) next[0].isDefault = true;
  persistAccounts(normalize(next));
  log.info("[opencode-claude] account removed", { id: wanted, boundSessions: bound });
}

/**
 * Change an account's display label and/or id. The label rides into the
 * model name, so a stale one is actively misleading. Every per-account store
 * is keyed by id, so an id change must migrate them (the caller passes
 * `migrate`) or the account silently loses its quota, usage and bindings.
 */
export function renameAccount(
  id: string,
  label: unknown,
  options?: { newId?: unknown; migrate?: (oldId: string, newId: string, label: string) => void },
): ClaudeAccount {
  assertRegistryMutable();
  const wanted = id.trim().toLowerCase();
  const existing = getAccounts();
  const current = existing.find((a) => a.id === wanted);
  if (!current) throw new AccountError(`unknown account "${wanted}"`, 404);

  const labelGiven = typeof label === "string";
  const trimmedLabel = labelGiven ? (label as string).trim() : "";
  const changingId =
    typeof options?.newId === "string" &&
    options.newId.trim().toLowerCase() !== "" &&
    options.newId.trim().toLowerCase() !== wanted;
  if (labelGiven && !trimmedLabel && !changingId) {
    throw new AccountError("label cannot be empty");
  }
  const clean = trimmedLabel || current.label;
  if (!clean) throw new AccountError("label cannot be empty");
  if (clean.length > 64) throw new AccountError("label is too long (max 64 chars)");
  if (trimmedLabel) assertLabelNamesNoLogin(clean);

  const rawNewId =
    typeof options?.newId === "string" ? options.newId.trim().toLowerCase() : "";
  const newId = rawNewId && rawNewId !== wanted ? rawNewId : null;
  if (newId) {
    if (!ACCOUNT_ID_PATTERN.test(newId)) {
      throw new AccountError(
        "id must be lowercase letters, digits, dot, dash or underscore (max 32 chars)",
      );
    }
    if (existing.some((a) => a.id === newId)) {
      throw new AccountError(`account "${newId}" already exists`, 409);
    }
  }

  const next = existing.map((account) => ({
    ...account,
    // Persisting an implicit ambient account needs a concrete dir, as in add.
    ...(account.id === AMBIENT_ACCOUNT_ID && !account.configDir
      ? { configDir: accountConfigDir(account) }
      : {}),
    ...(account.id === wanted
      ? { label: clean, ...(newId ? { id: newId } : {}) }
      : {}),
  }));
  persistAccounts(normalize(next));
  if (newId) options?.migrate?.(wanted, newId, clean);
  log.info("[opencode-claude] account renamed", {
    id: wanted,
    ...(newId ? { newId } : {}),
    label: clean,
  });
  return next.find((a) => a.id === (newId ?? wanted))!;
}

/** Which account new sessions land on when nothing else says otherwise. */
export function setDefaultAccount(id: string): ClaudeAccount {
  assertRegistryMutable();
  const wanted = id.trim().toLowerCase();
  const existing = getAccounts();
  if (!existing.some((a) => a.id === wanted)) {
    throw new AccountError(`unknown account "${wanted}"`, 404);
  }
  const next = existing.map((account) => ({
    ...account,
    ...(account.id === AMBIENT_ACCOUNT_ID && !account.configDir
      ? { configDir: accountConfigDir(account) }
      : {}),
    isDefault: account.id === wanted,
  }));
  persistAccounts(normalize(next));
  return next.find((a) => a.id === wanted)!;
}

export function getDefaultAccount(): ClaudeAccount {
  const list = getAccounts();
  return list.find((a) => a.isDefault) ?? list[0];
}

/** True once the operator configured more than one subscription. */
export function isMultiAccount(): boolean {
  return getAccounts().length > 1;
}

/** Resolve a caller-supplied account without silently changing subscriptions. */
export function requireAccount(id: string): ClaudeAccount {
  const wanted = id.trim().toLowerCase();
  const match = getAccounts().find((a) => a.id === wanted);
  if (match) return match;
  throw new AccountError(`unknown account "${wanted}"`, 404);
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
 * an explicit config dir inherit the parent env untouched. This is the only
 * account-auth mechanism the plugin has — it never touches credentials.
 *
 * A scoped account also drops an ambient CLAUDE_CODE_OAUTH_TOKEN: the CLI
 * prefers an env token over its credentials file, which would silently run
 * the turn on whichever subscription the operator's shell token belongs to.
 */
export function applyAccountEnv(
  account: ClaudeAccount,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (!account.configDir) return env;
  const scoped: Record<string, string | undefined> = {
    ...env,
    CLAUDE_CONFIG_DIR: account.configDir,
  };
  delete scoped.CLAUDE_CODE_OAUTH_TOKEN;
  return scoped;
}
