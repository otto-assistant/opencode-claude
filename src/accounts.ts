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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { log } from "./log.js";

export type ClaudeAccount = {
  /** Slug used in model ids, store keys and headers. */
  id: string;
  /** Human label shown in the model picker and session titles. */
  label: string;
  /**
   * One-glyph mark standing in for the label where space is scarce (model
   * names, session header). Optional: derived from the label when absent.
   */
  icon?: string;
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
/** Accounts declared in opencode.json — the baseline the panel writes on top of. */
let seededAccounts: ClaudeAccount[] = [];
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
  const icon = sanitizeIcon(entry.icon);
  return {
    id,
    label,
    ...(icon ? { icon } : {}),
    ...(configDir ? { configDir } : {}),
    isDefault: entry.default === true || entry.isDefault === true,
  };
}

/**
 * An icon is a MARK, not a second label: anything long enough to be read as
 * words defeats the point of having one, so it is rejected rather than
 * truncated into something the operator did not write.
 */
export function sanitizeIcon(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Count grapheme-ish units: an emoji with a variation selector or a ZWJ
  // sequence is one glyph on screen but several code points.
  const glyphs = [...trimmed.replace(/[\u200D\uFE0E\uFE0F]/g, "")].length;
  if (glyphs > 2) return undefined;
  return trimmed;
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
/**
 * Merge the declarative baseline with the panel-managed file. Accounts added
 * from the UI live in accounts.json and win on id conflicts, so an operator can
 * both declare accounts in opencode.json and add more at runtime without the
 * two layers fighting.
 */
function resolveRegistry(): ClaudeAccount[] {
  const fromDisk = fromEnv() ?? fromFile() ?? [];
  const merged = [...seededAccounts];
  for (const entry of fromDisk) {
    const at = merged.findIndex((a) => a.id === entry.id);
    if (at >= 0) merged[at] = entry;
    else merged.push(entry);
  }
  // A default declared in the mutable layer overrides the seeded one.
  if (fromDisk.some((a) => a.isDefault)) {
    for (const account of merged) {
      account.isDefault = fromDisk.some((a) => a.id === account.id && a.isDefault);
    }
  }
  accountsFileStamp = accountsFileMtime();
  return normalize(merged);
}

export function configureAccounts(raw: unknown): ClaudeAccount[] {
  seededAccounts = Array.isArray(raw)
    ? raw.map(parseAccountEntry).filter((a): a is ClaudeAccount => a !== null)
    : [];
  accounts = resolveRegistry();
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
  seededAccounts = [];
  accountsFileStamp = 0;
}

export function getAccounts(): ClaudeAccount[] {
  // Re-resolve when the panel rewrote accounts.json, so a newly connected
  // account is usable without restarting the OpenCode server.
  if (!accounts || accountsFileMtime() !== accountsFileStamp) {
    accounts = resolveRegistry();
  }
  return accounts;
}

/** Path of the panel-managed registry — surfaced in the UI for transparency. */
export function getAccountsFilePath(): string {
  return accountsFilePath();
}

/**
 * Concepts an account label can name, and the mark that stands for each.
 *
 * Order is priority: "Works Shared" is a shared account that happens to say
 * "work", so `shared` has to be tested before `work`, or every account in a
 * work org collapses onto the same glyph.
 */
const ICON_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/shared|team|pool/, "\u{1F465}"],
  [/personal|private|home/, "\u{1F3E0}"],
  [/work|job|office|corp|company/, "\u{1F4BC}"],
  [/test|dev|sandbox|lab|staging/, "\u{1F9EA}"],
  [/bot|agent|ci|auto/, "\u{1F916}"],
];

/**
 * Marks handed out when the label names no known concept, or names one already
 * taken. Two accounts wearing the same glyph would be worse than no glyph at
 * all -- telling them apart is the whole point -- so uniqueness beats meaning.
 */
const ICON_POOL = [
  "\u{1F535}",
  "\u{1F7E3}",
  "\u{1F7E0}",
  "\u{1F7E2}",
  "\u{1F534}",
  "\u{1F7E1}",
  "⬛",
  "⬜",
] as const;

function iconCandidates(account: ClaudeAccount, singleWordOnly: boolean): string[] {
  const label = (account.label || account.id).toLowerCase();
  const words = label.split(/[^a-z0-9]+/).filter(Boolean);
  // First pass: a label that IS the concept ("Personal") outranks one that
  // merely mentions it ("Work personal"), which would otherwise take the glyph
  // just by sorting earlier in the registry.
  if (singleWordOnly && words.length !== 1) return [];
  const haystack = singleWordOnly ? words[0] : `${label} ${account.id}`;
  return ICON_RULES.filter(([pattern]) => pattern.test(haystack)).map(([, icon]) => icon);
}

/**
 * One distinct mark per account, keyed by id.
 *
 * Resolved for the whole registry at once because uniqueness is a property of
 * the set, not of any single account: which glyph "Work personal" ends up with
 * depends on whether a plain "Personal" already claimed the house.
 */
export function accountIcons(list: ClaudeAccount[] = getAccounts()): Map<string, string> {
  const resolved = new Map<string, string>();
  const taken = new Set<string>();
  const claim = (id: string, icon: string) => {
    resolved.set(id, icon);
    taken.add(icon);
  };
  // An icon the operator pinned is never overruled by derivation.
  for (const account of list) {
    const explicit = sanitizeIcon(account.icon);
    if (explicit) claim(account.id, explicit);
  }
  for (const singleWordOnly of [true, false]) {
    for (const account of list) {
      if (resolved.has(account.id)) continue;
      const free = iconCandidates(account, singleWordOnly).find((i) => !taken.has(i));
      if (free) claim(account.id, free);
    }
  }
  for (const account of list) {
    if (resolved.has(account.id)) continue;
    claim(account.id, ICON_POOL.find((i) => !taken.has(i)) ?? "\u{1F518}");
  }
  return resolved;
}

/** The mark for one account. */
export function accountIcon(account: ClaudeAccount): string {
  return sanitizeIcon(account.icon) ?? accountIcons().get(account.id) ?? "\u{1F518}";
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
          ...(a.icon ? { icon: a.icon } : {}),
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
 *
 * The id is machinery — it keys every store and appears in model ids as
 * opus@<id> — but making an operator invent one, and get the character rules
 * right, is asking them to do the computer's job. Accents are folded rather
 * than dropped so "Cuenta Diseño" stays legible as "cuenta-diseno".
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

/**
 * The email address written inside a label, if there is one.
 *
 * Kept here, free of any identity import, because `identity.ts` already
 * imports this module and the cycle would be real.
 */
export function labelEmail(label: string): string | null {
  const match = /[^\s<>()[\],;:"]+@[^\s<>()[\],;:"]+\.[a-z]{2,}/i.exec(label || "");
  return match ? match[0] : null;
}

/**
 * A label must not name a login.
 *
 * The label is a string an operator types once; the login is resolved against
 * Anthropic and can turn out to be — or become — somebody else. When they
 * disagree the card contradicts itself three lines apart, and the half a human
 * reads first is the label. It happened: a slot titled
 * "Work · Daniel.Ibanez@cloudblue.com" whose token belonged to
 * daniel.speedo@cloudblue.com, with the true login printed right underneath.
 *
 * Note this guard alone would NOT have prevented that: the label matched the
 * (wrong) cached identity the moment it was written. That is why the
 * contradiction is also detected on read — see `labelLoginMismatch`.
 */
export function assertLabelNamesNoLogin(label: string): void {
  const email = labelEmail(label);
  if (!email) return;
  throw new AccountError(
    `a label must not contain an email address (${email}) — the login is resolved ` +
      `from the credential and shown on its own line, so a hand-written one only ` +
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
 * Register an account from the panel. The config dir is created on demand so
 * the OAuth flow that follows has somewhere to write credentials.
 */
export function addAccount(input: {
  id?: unknown;
  label?: unknown;
  icon?: unknown;
  configDir?: unknown;
  makeDefault?: boolean;
}): ClaudeAccount {
  const existing = getAccounts();
  const taken = new Set(existing.map((a) => a.id));
  const givenId = typeof input.id === "string" ? input.id.trim().toLowerCase() : "";
  const givenLabel =
    typeof input.label === "string" && input.label.trim() ? input.label.trim() : "";

  // An explicit id still wins — scripts and opencode.json rely on it — but the
  // normal path is to name the account and let the id follow.
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
  // behind the first account somebody adds from the UI.
  const baseline = existing.map((account) =>
    account.id === AMBIENT_ACCOUNT_ID && !account.configDir
      ? { ...account, configDir: accountConfigDir(account) }
      : account,
  );
  const icon = sanitizeIcon(input.icon);
  const created: ClaudeAccount = {
    id,
    label,
    ...(icon ? { icon } : {}),
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
export function removeAccount(id: string): void {
  const wanted = id.trim().toLowerCase();
  const existing = getAccounts();
  const target = existing.find((a) => a.id === wanted);
  if (!target) throw new AccountError(`unknown account "${wanted}"`, 404);
  if (existing.length === 1) {
    throw new AccountError("cannot remove the only account", 409);
  }
  const next = existing.filter((a) => a.id !== wanted);
  if (target.isDefault) next[0].isDefault = true;
  persistAccounts(normalize(next));
  log.info("[opencode-claude] account removed", { id: wanted });
}

/**
 * Change an account's display label. The label rides into the model name and
 * the panel, so a stale one (an account re-logged to a different subscription,
 * say) is actively misleading — worth being editable without hand-editing JSON.
 */
export function renameAccount(
  id: string,
  label: unknown,
  options?: { newId?: unknown; migrate?: (oldId: string, newId: string, label: string) => void },
): ClaudeAccount {
  const wanted = id.trim().toLowerCase();
  const existing = getAccounts();
  const current = existing.find((a) => a.id === wanted);
  if (!current) throw new AccountError(`unknown account "${wanted}"`, 404);

  // A blank label is a mistake, not "keep the old one" — unless the caller is
  // only changing the id, in which case omitting the label is the normal case.
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
  // Only when the caller is actually setting a label: an id-only rename must
  // not fail because of a bad label somebody else wrote before this rule.
  if (trimmedLabel) assertLabelNamesNoLogin(clean);

  // The id is not cosmetic: it appears in model ids as opus@<id>, and a slot
  // named for the account it used to hold is exactly how an operator ends up
  // believing they are spending a different subscription.
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
  // Every per-account store is keyed by id, so they all have to follow it or
  // the account silently loses its quota, usage, identity and session bindings.
  if (newId) options?.migrate?.(wanted, newId, clean);
  log.info("[opencode-claude] account renamed", {
    id: wanted,
    ...(newId ? { newId } : {}),
    label: clean,
  });
  return next.find((a) => a.id === (newId ?? wanted))!;
}

/**
 * Pin the mark for an account, or clear it back to the derived one.
 *
 * Derivation reads the label, so it can only guess: an account named after a
 * person or a client matches no concept and gets a coloured dot. This is the
 * escape hatch, and it is why the icon is persisted rather than computed fresh
 * every time.
 */
export function setAccountIcon(id: string, icon: unknown): ClaudeAccount {
  const wanted = id.trim().toLowerCase();
  const existing = getAccounts();
  const current = existing.find((a) => a.id === wanted);
  if (!current) throw new AccountError(`unknown account "${wanted}"`, 404);
  const clearing =
    icon === null || (typeof icon === "string" && icon.trim() === "");
  const clean = clearing ? undefined : sanitizeIcon(icon);
  if (!clearing && !clean) {
    throw new AccountError(
      "an icon must be a single glyph (an emoji or one character) — it stands in for the label, it is not a second one",
    );
  }
  const next = existing.map((account) => ({
    ...account,
    ...(account.id === AMBIENT_ACCOUNT_ID && !account.configDir
      ? { configDir: accountConfigDir(account) }
      : {}),
    ...(account.id === wanted ? { icon: clean } : {}),
  }));
  persistAccounts(normalize(next));
  log.info("[opencode-claude] account icon set", { id: wanted, icon: clean ?? null });
  return next.find((a) => a.id === wanted)!;
}

/** Which account new sessions land on when nothing else says otherwise. */
export function setDefaultAccount(id: string): ClaudeAccount {
  const wanted = id.trim().toLowerCase();
  const existing = getAccounts();
  if (!existing.some((a) => a.id === wanted)) {
    throw new AccountError(`unknown account "${wanted}"`, 404);
  }
  const next = existing.map((account) => ({
    ...account,
    // Persisting an implicit ambient account needs a concrete dir, same as add.
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
